import {
  authDomains,
  authOrganizations,
  authProviders,
} from '@pertexo/database/schema';
import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  findCommandResult,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import type { FederationSettings } from '@pertexo/contracts';
import type { Role } from '@pertexo/workflow-model';
import type { Pool, PoolClient } from 'pg';

import { organizationForWorkspace } from './authority.repository.js';
import type {
  DomainChallengeInput,
  FederationCommand,
  FederationScope,
} from './contract.js';
import { FederationConflictError } from './errors.js';
import { projectOrganization } from './settings.queries.js';

const STORED_SECRET_PAGE = 100;

export async function readFederationSettings(
  client: PoolClient,
  scope: FederationScope,
  role: Role,
): Promise<FederationSettings> {
  const organization = await organizationForWorkspace(
    client,
    scope.workspaceId,
  );
  return {
    configured: true,
    reason: null,
    canManage:
      role === 'owner' &&
      (organization === undefined ||
        organization.control_workspace_id === scope.workspaceId),
    organization:
      organization === undefined
        ? null
        : await projectOrganization(client, organization),
  };
}

async function requireDomainControl(client: PoolClient, workspaceId: string) {
  const organization = await organizationForWorkspace(client, workspaceId);
  if (organization?.control_workspace_id !== workspaceId)
    throw new FederationConflictError(
      'owner_required',
      'Manage domains from the control workspace.',
    );
  return organization;
}

export async function readDomainChallenge(
  client: PoolClient,
  input: DomainChallengeInput,
) {
  const organization = await requireDomainControl(client, input.workspaceId);
  const [row] = await drizzle(client)
    .select({
      domain: authDomains.domain,
      challenge: authDomains.challenge,
    })
    .from(authDomains)
    .where(
      and(
        eq(authDomains.id, input.domainId),
        eq(authDomains.organizationId, organization.id),
        isNull(authDomains.verifiedAt),
        gt(authDomains.challengeExpiresAt, sql`clock_timestamp()`),
      ),
    )
    .catch(rethrowQueryFailure);
  if (row?.challenge === null || row === undefined)
    throw new FederationConflictError(
      'dns_unverified',
      'The DNS challenge is unavailable or expired.',
    );
  return { domain: row.domain, challenge: row.challenge };
}

export async function readDomainVerificationResult(
  client: PoolClient,
  input: FederationCommand & DomainChallengeInput,
) {
  await requireDomainControl(client, input.workspaceId);
  return findCommandResult<FederationSettings>(client, {
    workspaceId: input.workspaceId,
    scope: input.actorId,
    operation: 'identity.domain.verify',
    idempotencyKey: input.idempotencyKey,
    request: {
      domainId: input.domainId,
      expectedRevision: input.expectedRevision,
    },
  });
}

/** Startup's check that every stored secret still opens: no member is acting. */
export async function checkFederationStoredSecrets(
  pool: Pool,
  check: (sealed: unknown, workspaceId: string, providerId: string) => void,
): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const batch = await storedProviderSecrets(pool, after);
    for (const row of batch)
      check(row.sealed_secret, row.control_workspace_id, row.id);
    const last = batch.at(-1);
    if (batch.length < STORED_SECRET_PAGE || last === undefined) return;
    after = last.id;
  }
}

function storedProviderSecrets(pool: Pool, after: string | null) {
  return drizzle(pool)
    .select({
      id: authProviders.id,
      sealed_secret: authProviders.sealedSecret,
      control_workspace_id: authOrganizations.controlWorkspaceId,
    })
    .from(authProviders)
    .innerJoin(
      authOrganizations,
      eq(authOrganizations.id, authProviders.organizationId),
    )
    .where(
      and(
        isNotNull(authProviders.sealedSecret),
        after === null ? undefined : gt(authProviders.id, after),
      ),
    )
    .orderBy(asc(authProviders.id))
    .limit(STORED_SECRET_PAGE)
    .catch(rethrowQueryFailure);
}
