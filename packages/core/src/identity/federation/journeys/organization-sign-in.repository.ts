import {
  authDomains,
  authProviders,
  authOrganizations,
  workspaces,
  authFederationAttempts,
} from '@pertexo/database/schema';
import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  isUniqueConstraintFailure,
} from '@pertexo/database/primitives';
import {
  ACTIVE_WORKSPACE_STATUSES,
  FEDERATION_LIMITS,
  UNPURGED_WORKSPACE_STATUSES,
} from '@pertexo/workflow-model';
import type { Pool } from 'pg';
import type { FederationDiscovery } from '@pertexo/contracts';
import { withPlatformTransaction } from '@pertexo/database/platform';
import { withWorkspaceAccess } from '../../../shared/workspace-access.js';
import {
  lockFederationWorkspace,
  organizationForWorkspace,
  requireFederationOwner,
} from '../management/authority.repository.js';
import { FederationConflictError } from '../management/errors.js';
import type { FederationScope } from '../management/contract.js';
import { readEligibleAuthenticationSession } from '../sessions/authority.repository.js';
import { SignInProofRejectedError } from '../accounts/rejection.js';
import {
  readFederationProvider,
  findFederationAttempt,
} from './records.queries.js';
import { completeFederationJourney } from './complete.repository.js';
import type { CompleteFederationJourney } from './contract.js';
import type {
  StartFederationJourney,
  FederationCompletion,
} from './contract.js';

/**
 * Sign-in has no member behind it, so all but the owner's provider test stay
 * off `withWorkspaceAccess`. `start` learns the workspace from the provider and
 * only a test has an owner; `complete` spans every linked workspace.
 */
export class OrganizationSignInCommands {
  constructor(
    private readonly input: Readonly<{ pool: Pool; sessionTtlSeconds: number }>,
  ) {}
  async discover(domain: string): Promise<FederationDiscovery> {
    const rows = await drizzle(this.input.pool)
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
    return {
      required: rows[0]?.require_sso ?? false,
      providers: rows.flatMap(({ id, name, kind }) => {
        const providerUnavailable =
          id === null || name === null || kind === null;
        return providerUnavailable ? [] : [{ id, name, kind }];
      }),
    };
  }
  provider(providerId: string, domain: string) {
    return readFederationProvider(this.input.pool, providerId, domain);
  }
  testProvider(
    input: FederationScope & Readonly<{ providerId: string; domainId: string }>,
  ) {
    return withWorkspaceAccess(
      this.input.pool,
      input,
      {
        mode: 'exclusive',
        capability: 'governance:manage',
        statuses: ACTIVE_WORKSPACE_STATUSES,
      },
      async (client, role) => {
        requireFederationOwner(role, 'change');
        const organization = await organizationForWorkspace(
          client,
          input.workspaceId,
        );
        if (organization?.control_workspace_id !== input.workspaceId)
          throw new FederationConflictError(
            'unavailable',
            'The provider or verified domain is unavailable.',
          );
        const [domain] = await drizzle(client)
          .select({ domain: authDomains.domain })
          .from(authDomains)
          .where(
            and(
              eq(authDomains.id, input.domainId),
              eq(authDomains.organizationId, organization.id),
              isNotNull(authDomains.verifiedAt),
            ),
          )
          .catch(rethrowQueryFailure);
        if (domain === undefined)
          throw new FederationConflictError(
            'unavailable',
            'The provider or verified domain is unavailable.',
          );
        const material = await readFederationProvider(
          client,
          input.providerId,
          domain.domain,
          { testing: true },
        );
        if (material?.provider.organizationId !== organization.id)
          throw new FederationConflictError(
            'unavailable',
            'The provider or verified domain is unavailable.',
          );
        return material;
      },
    );
  }
  async start(input: StartFederationJourney): Promise<void> {
    await withPlatformTransaction(this.input.pool, async (client) => {
      const [provider] = await drizzle(client)
        .select({ control_workspace_id: authOrganizations.controlWorkspaceId })
        .from(authProviders)
        .innerJoin(
          authOrganizations,
          eq(authOrganizations.id, authProviders.organizationId),
        )
        .where(eq(authProviders.id, input.providerId))
        .catch(rethrowQueryFailure);
      if (provider === undefined) throw new SignInProofRejectedError();
      if (input.purpose === 'test') {
        if (
          input.ownerUserId === undefined ||
          input.ownerSessionId === undefined
        )
          throw new SignInProofRejectedError();
        await lockFederationWorkspace(client, {
          workspaceId: provider.control_workspace_id,
          actorId: input.ownerUserId,
        });
        if (
          (
            await readEligibleAuthenticationSession(
              client,
              input.ownerSessionId,
            )
          )?.userId !== input.ownerUserId
        )
          throw new SignInProofRejectedError();
      } else
        await drizzle(client)
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, provider.control_workspace_id))
          .for('share')
          .catch(rethrowQueryFailure);
      const db = drizzle(client);
      const source = db
        .select({
          id: sql<string>`${input.id}::uuid`.as('id'),
          organizationId: authProviders.organizationId,
          providerId: authProviders.id,
          providerRevision: authProviders.revision,
          domainId: authDomains.id,
          purpose: sql<'sign_in' | 'test'>`${input.purpose}::text`.as(
            'purpose',
          ),
          ownerUserId: sql<
            string | null
          >`${input.ownerUserId ?? null}::uuid`.as('owner_user_id'),
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
          expiresAt: sql<Date>`clock_timestamp()+interval '5 minutes'`.as(
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
      if (inserted.length !== 1) throw new SignInProofRejectedError();
    });
  }
  find(stateDigest: Buffer, browserDigest: Buffer) {
    return findFederationAttempt(this.input.pool, stateDigest, browserDigest);
  }
  complete(input: CompleteFederationJourney): Promise<FederationCompletion> {
    return withPlatformTransaction(this.input.pool, (client) =>
      completeFederationJourney(client, input, this.input.sessionTtlSeconds),
    ).catch((error: unknown) => {
      const proofRefused =
        error instanceof SignInProofRejectedError ||
        isUniqueConstraintFailure(error);
      if (proofRefused) return { kind: 'failed' } as const;
      throw error;
    });
  }
}
