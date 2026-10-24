import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { idempotencyRecords } from '../../schema/runs/support.js';
import { rethrowQueryFailure } from '../query-errors.js';
import { canonicalJson } from '@pertexo/workflow-model';
import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

import { generatePersistedId } from '../persisted-id.js';

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

/**
 * The request the key was used for: hashed here, or the digest a caller
 * already computed over the request it received.
 */
type CommandRequest =
  | Readonly<{ request: unknown; requestHash?: undefined }>
  | Readonly<{ requestHash: string; request?: undefined }>;

type CommandLookup = CommandIdentity &
  CommandRequest &
  Readonly<{
    /** The area's own error for a key reused with a different request. */
    conflict?: () => Error;
  }>;

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const requestDigest = (command: CommandRequest): string =>
  command.requestHash ?? sha256(canonicalJson(command.request));

function conflict(command: CommandLookup): Error {
  return command.conflict?.() ?? new IdempotencyConflictError();
}

/** Namespaces public token IDs, never secrets, outside caller-selected command keys. */
export function credentialCommandScope(
  scope: string,
  publicTokenId?: string,
): string {
  return publicTokenId === undefined
    ? scope
    : `api_token:${sha256(canonicalJson({ credentialId: publicTokenId, scope }))}`;
}

/**
 * Claims a command's key in the caller's transaction, which must also
 * complete it. Returns the stored result of an exact retry, or null for a new
 * command. The claim stays locked until the transaction ends, so a concurrent
 * retry waits for the first one. The same key with a different request
 * throws.
 */
export async function claimCommand<Result = unknown>(
  client: PoolClient,
  command: CommandLookup & Readonly<{ resourceId: string }>,
): Promise<Result | null> {
  const keyHash = sha256(command.idempotencyKey);
  const requestHash = requestDigest(command);
  const db = drizzle(client);
  const inserted = await db
    .insert(idempotencyRecords)
    .values({
      id: generatePersistedId(),
      workspaceId: command.workspaceId,
      operation: command.operation,
      scope: command.scope,
      keyHash,
      requestHash,
      status: 'in_progress',
      resourceId: command.resourceId,
      resultRef: {},
    })
    .onConflictDoNothing({
      target: [
        idempotencyRecords.workspaceId,
        idempotencyRecords.operation,
        idempotencyRecords.scope,
        idempotencyRecords.keyHash,
      ],
    })
    .returning({ id: idempotencyRecords.id })
    .catch(rethrowQueryFailure);
  const [row] = await db
    .select({
      requestHash: idempotencyRecords.requestHash,
      status: idempotencyRecords.status,
      resultRef: sql<Result>`${idempotencyRecords.resultRef}`,
    })
    .from(idempotencyRecords)
    .where(commandPredicate(command, keyHash))
    .for('update')
    .catch(rethrowQueryFailure);
  if (row === undefined) throw new Error('Command claim is missing');
  if (row.requestHash !== requestHash) throw conflict(command);
  if (row.status === 'completed') return row.resultRef;
  // A claim completes in the transaction that made it, so any other state
  // another transaction left behind is damage, not a command to resume.
  if (inserted.length !== 1) throw new Error('Command claim is not resumable');
  return null;
}

/**
 * Reads a completed command's stored result without claiming its key, so a
 * caller can answer an exact retry before doing expensive work. Null when the
 * key is unused or its command has not completed.
 */
export async function findCommandResult<Result = unknown>(
  client: PoolClient,
  command: CommandLookup,
): Promise<Result | null> {
  const [row] = await drizzle(client)
    .select({
      requestHash: idempotencyRecords.requestHash,
      status: idempotencyRecords.status,
      resultRef: sql<Result>`${idempotencyRecords.resultRef}`,
    })
    .from(idempotencyRecords)
    .where(commandPredicate(command, sha256(command.idempotencyKey)))
    .catch(rethrowQueryFailure);
  if (row === undefined) return null;
  if (row.requestHash !== requestDigest(command)) throw conflict(command);
  return row.status === 'completed' ? row.resultRef : null;
}

/** Stores a command's result so an exact retry gets it back. */
export async function completeCommand(
  client: PoolClient,
  command: CommandIdentity,
  result: unknown,
): Promise<void> {
  const completed = await drizzle(client)
    .update(idempotencyRecords)
    .set({
      status: 'completed',
      resultRef: sql`${JSON.stringify(result)}::jsonb`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(commandPredicate(command, sha256(command.idempotencyKey)))
    .returning({ id: idempotencyRecords.id })
    .catch(rethrowQueryFailure);
  if (completed.length !== 1) throw new Error('Command claim is missing');
}

function commandPredicate(command: CommandIdentity, keyHash: string) {
  return and(
    eq(idempotencyRecords.workspaceId, command.workspaceId),
    eq(idempotencyRecords.operation, command.operation),
    eq(idempotencyRecords.scope, command.scope),
    eq(idempotencyRecords.keyHash, keyHash),
  );
}
