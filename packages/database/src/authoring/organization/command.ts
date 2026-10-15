import type { PoolClient } from 'pg';

import { claimCommand, completeCommand } from '../../platform/idempotency.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import type { Role } from '../../tenant-access/policy.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';

export type OrganizationScope = Readonly<{
  workspaceId: string;
  actorId: string;
}>;

/** The record a command changed, for the audit log. */
export type OrganizationAudit = Readonly<{
  action: string;
  targetId: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type OrganizationCommand<T> = Readonly<{
  operation: string;
  /** The folder, tag or workflow it changes; null when it creates one. */
  target: string | null;
  idempotencyKey: string;
  request: unknown;
  roles: readonly Role[];
  /** Applies the change; runs under the workspace's organization lock. */
  apply: () => Promise<Readonly<{ result: T; audit: OrganizationAudit }>>;
  /** Checks that the actor may still see an earlier result of this command. */
  replay?: () => Promise<void>;
}>;

/**
 * Organization writes in one workspace run one at a time, so folder and tag
 * limits, the folder hierarchy and emptiness checks see each other's changes.
 */
async function lockOrganization(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended('workflow-organization:' || $1, 0))",
    [workspaceId],
  );
}

/**
 * Runs one organization command in the caller's tenant transaction: checks the
 * actor's role, answers an exact retry with its first result, and otherwise
 * applies the change and records it.
 */
export async function runOrganizationCommand<T>(
  client: PoolClient,
  scope: OrganizationScope,
  command: OrganizationCommand<T>,
): Promise<Readonly<{ result: T; replayed: boolean }>> {
  await lockWorkflowAuthoringAuthority(
    client,
    scope.workspaceId,
    scope.actorId,
    command.roles,
  );
  const identity = {
    workspaceId: scope.workspaceId,
    operation: command.operation,
    scope: `${scope.actorId}:${command.target ?? 'new'}`,
    idempotencyKey: command.idempotencyKey,
  };
  const stored = await claimCommand(client, {
    ...identity,
    request: command.request,
    resourceId: command.target ?? generatePersistedId(),
  });
  if (stored !== null) {
    await command.replay?.();
    return { result: stored as T, replayed: true };
  }
  await lockOrganization(client, scope.workspaceId);
  const { result, audit } = await command.apply();
  await client.query(
    `insert into app.audit_events
       (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
     values ($1, $2, $3, $4, 'workflow_organization', $5, $6::jsonb)`,
    [
      generatePersistedId(),
      scope.workspaceId,
      scope.actorId,
      audit.action,
      audit.targetId,
      JSON.stringify(audit.metadata ?? {}),
    ],
  );
  await completeCommand(client, identity, result);
  return { result, replayed: false };
}
