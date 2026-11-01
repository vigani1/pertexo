import {
  appendAuditFact,
  claimCommand,
  completeCommand,
} from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

import type { DataTableMutation } from './contract.js';

type TableCommand<T extends object> = Readonly<{
  operation: string;
  /** Null when the work writes its own, more specific, audit event. */
  audit:
    | ((result: T) => Readonly<{
        targetId: string;
        targetType: 'workspace' | 'data_table';
        metadata?: Readonly<Record<string, unknown>>;
      }>)
    | null;
  request: unknown;
  work: () => Promise<T>;
}>;

/** An exact retry gets the first result back; anything new does its work once. */
export async function runTableCommand<T extends object>(
  client: PoolClient,
  input: DataTableMutation,
  { operation, audit, request, work }: TableCommand<T>,
): Promise<T> {
  const identity = {
    workspaceId: input.workspaceId,
    scope: input.actorId,
    operation,
    idempotencyKey: input.idempotencyKey,
  };
  const prior = await claimCommand<T>(client, {
    ...identity,
    resourceId: input.workspaceId,
    request,
  });
  if (prior !== null) return prior;
  const result = await work();
  if (audit !== null)
    await appendAuditFact(client, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: operation,
      ...audit(result),
    });
  await completeCommand(client, identity, result);
  return result;
}
