import type { AuditMetadata } from '@pertexo/database/primitives';
import {
  appendAuditFact,
  withWorkspaceTransaction,
  type WorkspaceTransaction,
} from '@pertexo/database/primitives';
import { operatorCommands } from '@pertexo/database/schema';
import { eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';

import {
  OperatorCommandConflictError,
  type CommandRequest,
  type GenericOperatorCommandResult,
} from './contract.js';
import { requestFingerprint } from './fingerprint.js';

/** Seed of the advisory lock that serializes requests reusing one command id. */
const COMMAND_LOCK_SEED = 7_166_118_813;

export type OperatorTransactionContext = Readonly<{
  pool: Pool;
  options: Readonly<{ lockTimeoutMs: number; statementTimeoutMs: number }>;
}>;

/**
 * An operator acts across workspaces as the maintenance role and belongs to none
 * of them, so there's no membership to check: its authority is holding the role,
 * and everything it does is audited with its actor reference.
 */
export function withOperatorTransaction<T>(
  { pool, options }: OperatorTransactionContext,
  workspaceId: string,
  signal: AbortSignal | undefined,
  work: (transaction: WorkspaceTransaction) => Promise<T>,
): Promise<T> {
  return withWorkspaceTransaction(
    pool,
    workspaceId,
    async (transaction) => {
      await transaction.db.execute(
        sql`select set_config('lock_timeout', ${String(options.lockTimeoutMs)}, true)`,
      );
      return work(transaction);
    },
    {
      statementTimeoutMillis: options.statementTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    },
  );
}

/**
 * Runs one command in one transaction: a request that reuses a command id
 * replays the stored outcome when it is the same request and conflicts
 * otherwise; a new request decides, applies and records its outcome.
 */
export async function runOperatorCommand(
  context: OperatorTransactionContext,
  request: CommandRequest,
): Promise<GenericOperatorCommandResult> {
  const fingerprint = requestFingerprint(request);
  const outcome = await withOperatorTransaction(
    context,
    request.workspaceId,
    request.signal,
    async (transaction): Promise<GenericOperatorCommandResult | 'conflict'> => {
      await transaction.db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${request.commandId}, ${COMMAND_LOCK_SEED}))`,
      );
      const [existing] = await transaction.db
        .select({
          outcome: operatorCommands.outcome,
          requestFingerprint: operatorCommands.requestFingerprint,
          result: operatorCommands.result,
          status: operatorCommands.status,
        })
        .from(operatorCommands)
        .where(eq(operatorCommands.id, request.commandId));
      if (existing !== undefined) {
        const same = existing.requestFingerprint === fingerprint;
        await appendOperatorAudit(transaction, request, {
          outcome: same ? existing.outcome : 'conflict',
          replayed: true,
          requestFingerprint: fingerprint,
        });
        if (!same) return 'conflict';
        return Object.freeze({
          commandId: request.commandId,
          outcome: existing.outcome,
          replayed: true,
          result: Object.freeze(existing.result),
          status: existing.status,
        });
      }

      const decision = await request.decide(transaction, fingerprint);
      const status = (decision.pending ?? false) ? 'pending' : 'completed';
      await transaction.db.insert(operatorCommands).values({
        id: request.commandId,
        workspaceId: transaction.workspaceId,
        commandType: request.commandType,
        dryRun: request.dryRun,
        requestFingerprint: fingerprint,
        status,
        outcome: decision.outcome,
        result: decision.result,
        completedAt: status === 'pending' ? null : sql`clock_timestamp()`,
      });
      await appendOperatorAudit(transaction, request, {
        ...decision.auditMetadata,
        outcome: decision.outcome,
        requestFingerprint: fingerprint,
      });
      return Object.freeze({
        commandId: request.commandId,
        outcome: decision.outcome,
        replayed: false,
        result: Object.freeze(decision.result),
        status,
      });
    },
  );
  // The conflicting attempt is audited before it is refused.
  if (outcome === 'conflict') throw new OperatorCommandConflictError();
  return outcome;
}

function appendOperatorAudit(
  transaction: WorkspaceTransaction,
  request: CommandRequest,
  metadata: AuditMetadata,
): Promise<unknown> {
  return appendAuditFact(transaction, {
    workspaceId: transaction.workspaceId,
    action: `operator.${request.commandType.replaceAll('.', '_')}`,
    targetType: request.target.type,
    targetId: request.target.id,
    requestId: request.commandId,
    metadata: {
      ...request.auditMetadata,
      ...metadata,
      actorRef: request.actorRef,
      dryRun: request.dryRun,
      reason: request.reason,
    },
  });
}
