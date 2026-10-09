import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

import { generatePersistedId } from './persisted-id.js';

/** A command key was reused for a different request. */
export class IdempotencyConflictError extends Error {
  override readonly name = 'IdempotencyConflictError';
  constructor() {
    super('Idempotency key was used for a different request');
  }
}

/** One command under one idempotency key. */
export type CommandIdentity = Readonly<{
  workspaceId: string;
  /** What the command does, e.g. `folder.create`. */
  operation: string;
  /** Who and what the key belongs to, e.g. the actor and the target. */
  scope: string;
  idempotencyKey: string;
}>;

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/**
 * Claims a command's key in the caller's transaction. Returns the stored
 * result of an exact retry, or null for a new command. The claim stays locked
 * until the transaction ends, so a concurrent retry waits for the first one.
 * The same key with a different request throws.
 */
export async function claimCommand(
  client: PoolClient,
  command: CommandIdentity & Readonly<{ request: unknown; resourceId: string }>,
): Promise<unknown> {
  const keyHash = sha256(command.idempotencyKey);
  const requestHash = sha256(JSON.stringify(command.request));
  await client.query(
    `insert into app.idempotency_records
       (id, workspace_id, operation, scope, key_hash, request_hash, status,
        resource_id, result_ref)
     values ($1, $2, $3, $4, $5, $6, 'in_progress', $7, '{}'::jsonb)
     on conflict (workspace_id, operation, scope, key_hash) do nothing`,
    [
      generatePersistedId(),
      command.workspaceId,
      command.operation,
      command.scope,
      keyHash,
      requestHash,
      command.resourceId,
    ],
  );
  const claimed = await client.query<{
    request_hash: string;
    result_ref: unknown;
    status: string;
  }>(
    `select request_hash, status, result_ref from app.idempotency_records
     where workspace_id = $1 and operation = $2 and scope = $3 and key_hash = $4
     for update`,
    [command.workspaceId, command.operation, command.scope, keyHash],
  );
  const row = claimed.rows[0];
  if (row === undefined) throw new Error('Command claim is missing');
  if (row.request_hash !== requestHash) throw new IdempotencyConflictError();
  return row.status === 'completed' ? row.result_ref : null;
}

/** Stores a command's result so an exact retry gets it back. */
export async function completeCommand(
  client: PoolClient,
  command: CommandIdentity,
  result: unknown,
): Promise<void> {
  const completed = await client.query(
    `update app.idempotency_records
     set status = 'completed', result_ref = $5::jsonb, updated_at = clock_timestamp()
     where workspace_id = $1 and operation = $2 and scope = $3 and key_hash = $4`,
    [
      command.workspaceId,
      command.operation,
      command.scope,
      sha256(command.idempotencyKey),
      JSON.stringify(result),
    ],
  );
  if (completed.rowCount !== 1) throw new Error('Command claim is missing');
}
