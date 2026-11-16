import { findCommandResult } from '@pertexo/database/primitives';
import type { FederationSettings } from '@pertexo/contracts';

import type { PoolClient } from 'pg';
import { organizationForWorkspace } from './authority.repository.js';

import type {
  DomainChallengeInput,
  FederationCommand,
} from './federation-management.types.js';
import { FederationConflictError } from './federation-management.errors.js';

import { readOpenChallenge } from './reads.repository.js';

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
  const row = await readOpenChallenge(client, input.domainId, organization.id);
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
