import {
  authDomains,
  authProviders,
  authOrganizations,
  workspaces,
  authFederationAttempts,
} from '@pertexo/database/schema';

import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { UNPURGED_WORKSPACE_STATUSES } from '@pertexo/policy';

import { FEDERATION_LIMITS } from '@pertexo/workflow-model';

import type { Pool, PoolClient } from 'pg';

import type { StartFederationJourney } from './federation-journey.types.js';
import { MINUTE_INTERVAL } from '../../../shared/sql-intervals.repository.js';

// An organization sign-in must come back from its provider within this.
const JOURNEY_LIFETIME_MINUTES = 5;
const JOURNEY_LIFETIME = sql`${JOURNEY_LIFETIME_MINUTES}*${MINUTE_INTERVAL}`;

/** The organization's verified domain name, if the domain is its and verified. */
export async function readVerifiedDomain(
  client: PoolClient,
  domainId: string,
  organizationId: string,
): Promise<string | undefined> {
  const [domain] = await drizzle(client)
    .select({ domain: authDomains.domain })
    .from(authDomains)
    .where(
      and(
        eq(authDomains.id, domainId),
        eq(authDomains.organizationId, organizationId),
        isNotNull(authDomains.verifiedAt),
      ),
    )
    .catch(rethrowQueryFailure);
  return domain?.domain;
}

/** The control workspace of the provider's organization, if the provider exists. */
export async function readProviderControlWorkspace(
  client: PoolClient,
  providerId: string,
): Promise<string | undefined> {
  const [provider] = await drizzle(client)
    .select({ control_workspace_id: authOrganizations.controlWorkspaceId })
    .from(authProviders)
    .innerJoin(
      authOrganizations,
      eq(authOrganizations.id, authProviders.organizationId),
    )
    .where(eq(authProviders.id, providerId))
    .catch(rethrowQueryFailure);
  return provider?.control_workspace_id;
}

/** Holds the control workspace still while a sign-in attempt is written. */
export async function shareLockWorkspace(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await drizzle(client)
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('share')
    .catch(rethrowQueryFailure);
}

/** Whether the attempt was written: the provider, revision and verified domain must still match. */
export async function insertFederationAttempt(
  client: PoolClient,
  input: StartFederationJourney,
): Promise<boolean> {
  const db = drizzle(client);
  const source = db
    .select({
      id: sql<string>`${input.id}::uuid`.as('id'),
      organizationId: authProviders.organizationId,
      providerId: authProviders.id,
      providerRevision: authProviders.revision,
      domainId: authDomains.id,
      purpose: sql<'sign_in' | 'test'>`${input.purpose}::text`.as('purpose'),
      ownerUserId: sql<string | null>`${input.ownerUserId ?? null}::uuid`.as(
        'owner_user_id',
      ),
      ownerSessionId: sql<
        string | null
      >`${input.ownerSessionId ?? null}::uuid`.as('owner_session_id'),
      stateDigest:
        sql<Buffer>`${sql.param(input.stateDigest, authFederationAttempts.stateDigest)}::bytea`.as(
          'state_digest',
        ),
      browserDigest:
        sql<Buffer>`${sql.param(input.browserDigest, authFederationAttempts.browserDigest)}::bytea`.as(
          'browser_digest',
        ),
      returnPath: sql<string>`${input.returnPath}::text`.as('return_path'),
      requestId: sql<string | null>`null::text`.as('request_id'),
      requestCreatedAt: sql<Date | null>`null::timestamptz`.as(
        'request_created_at',
      ),
      expiresAt: sql<Date>`clock_timestamp()+${JOURNEY_LIFETIME}`.as(
        'expires_at',
      ),
      consumedAt: sql<Date | null>`null::timestamptz`.as('consumed_at'),
      createdAt: sql<Date>`clock_timestamp()`.as('created_at'),
    })
    .from(authProviders)
    .innerJoin(
      authOrganizations,
      eq(authOrganizations.id, authProviders.organizationId),
    )
    .innerJoin(
      workspaces,
      eq(workspaces.id, authOrganizations.controlWorkspaceId),
    )
    .innerJoin(
      authDomains,
      and(
        eq(authDomains.organizationId, authProviders.organizationId),
        isNotNull(authDomains.verifiedAt),
      ),
    )
    .where(
      and(
        eq(authProviders.id, input.providerId),
        eq(authProviders.revision, input.providerRevision),
        eq(authDomains.id, input.domainId),
        inArray(workspaces.status, UNPURGED_WORKSPACE_STATUSES),
        or(eq(authProviders.enabled, true), sql`${input.purpose}='test'`),
      ),
    );
  const inserted = await db
    .insert(authFederationAttempts)
    .select(source)
    .returning({ id: authFederationAttempts.id })
    .catch(rethrowQueryFailure);
  return inserted.length === 1;
}

/** The verified domain's requirement and its enabled providers, by name. */
export async function readDomainDiscovery(pool: Pool, domain: string) {
  const rows = await drizzle(pool)
    .select({
      require_sso: authDomains.requireSso,
      id: authProviders.id,
      name: authProviders.name,
      kind: authProviders.kind,
    })
    .from(authDomains)
    .innerJoin(
      authOrganizations,
      eq(authOrganizations.id, authDomains.organizationId),
    )
    .innerJoin(
      workspaces,
      eq(workspaces.id, authOrganizations.controlWorkspaceId),
    )
    .leftJoin(
      authProviders,
      and(
        eq(authProviders.organizationId, authDomains.organizationId),
        eq(authProviders.enabled, true),
      ),
    )
    .where(
      and(
        eq(authDomains.domain, domain),
        inArray(workspaces.status, UNPURGED_WORKSPACE_STATUSES),
        isNotNull(authDomains.verifiedAt),
      ),
    )
    .orderBy(asc(authProviders.name), asc(authProviders.id))
    .limit(FEDERATION_LIMITS.providers)
    .catch(rethrowQueryFailure);
  return rows;
}
