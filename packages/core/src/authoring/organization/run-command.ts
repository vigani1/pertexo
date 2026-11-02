import type { AuditMetadata } from '@pertexo/database/primitives';
import {
  appendAuditFact,
  rethrowQueryFailure,
  claimCommand,
  completeCommand,
} from '@pertexo/database/primitives';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { requireReadableReceipt } from '../../shared/receipts.js';

import { generatePersistedId } from '@pertexo/database/platform';
import type { OrganizationActor } from './session.js';

/** The record a command changed, for the audit log. */
export type OrganizationAudit = Readonly<{
  action: string;
  targetId: string;
  metadata?: AuditMetadata;
}>;

export type OrganizationCommand<T> = Readonly<{
  operation: string;
  /** The folder, tag or workflow it changes; null when it creates one. */
  target: string | null;
  idempotencyKey: string;
  request: unknown;
  /** The shape of the result this command stores, which a replay checks. */
  receipt: z.ZodType;
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
  await drizzle(client)
    .execute(
      sql`select pg_advisory_xact_lock(hashtextextended('workflow-organization:' || ${workspaceId},0))`,
    )
    .catch(rethrowQueryFailure);
}

/**
 * Runs one organization command inside `session.command`: answers an exact retry
 * with its first result, and otherwise applies the change and records it.
 */
export async function runOrganizationCommand<T>(
  client: PoolClient,
  scope: OrganizationActor,
  command: OrganizationCommand<T>,
): Promise<Readonly<{ result: T; replayed: boolean }>> {
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
    requireReadableReceipt(command.receipt, stored);
    await command.replay?.();
    return { result: stored as T, replayed: true };
  }
  await lockOrganization(client, scope.workspaceId);
  const { result, audit } = await command.apply();
  await appendAuditFact(client, {
    workspaceId: scope.workspaceId,
    actorId: scope.actorId,
    action: audit.action,
    targetType: 'workflow_organization',
    targetId: audit.targetId,
    metadata: audit.metadata ?? {},
  });
  await completeCommand(client, identity, result);
  return { result, replayed: false };
}
