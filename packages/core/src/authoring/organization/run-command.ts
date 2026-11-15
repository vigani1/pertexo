import type { AuditMetadata } from '@pertexo/database/primitives';
import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import { appendAuditFact } from '../../governance/audit/facts.js';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { decodeStoredReceipt } from '../../shared/receipts.js';

import {
  generatePersistedId,
  credentialCommandScope,
} from '@pertexo/database/platform';
import type { OrganizationActor } from './session.js';
import { lockOrganization } from './organization-lock.repository.js';

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
  receipt: z.ZodType<T>;
  /** Applies the change; runs under the workspace's organization lock. */
  apply: () => Promise<
    Readonly<{ result: NoInfer<T>; audit: OrganizationAudit }>
  >;
  /** Checks that the actor may still see an earlier result of this command. */
  replay?: () => Promise<void>;
}>;

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
    scope: credentialCommandScope(
      `${scope.actorId}:${command.target ?? 'new'}`,
      scope.commandCredentialId,
    ),
    idempotencyKey: command.idempotencyKey,
  };
  const stored = await claimCommand(client, {
    ...identity,
    request: command.request,
    resourceId: command.target ?? generatePersistedId(),
  });
  if (stored !== null) {
    const result = decodeStoredReceipt(command.receipt, stored);
    await command.replay?.();
    return { result, replayed: true };
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
