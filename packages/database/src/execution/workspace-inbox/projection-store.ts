import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/database-runtime.js';
import type {
  WorkspaceInboxProjectionInput,
  WorkspaceInboxProjectionStore,
  WorkspaceInboxProjectionResult,
} from './projection-contract.js';
import { runInboxWriteTransaction } from './inbox-write-transaction.js';
import {
  admitInboxWrite,
  createInboxWriteLifetime,
  inboxWritesAvailable,
  withinInboxWriteSettlement,
} from './write-activity.js';
import { checkInboxProjectionReadiness } from './projection-readiness.js';
import { workspaceInboxDeliveryInputSchema } from './capture-contract.js';

const fenceSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
const resultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('projected'),
      processedCount: z.number().int().min(0).max(100),
      insertedCount: z.number().int().min(0).max(100),
      skippedCount: z.number().int().min(0).max(100),
      hasMore: z.boolean(),
    })
    .strict()
    .refine(
      (value) =>
        value.processedCount === value.insertedCount + value.skippedCount,
    ),
  z.object({ kind: z.literal('owned'), fenceToken: fenceSchema }).strict(),
  z
    .object({
      kind: z.enum([
        'completed',
        'not_captured',
        'unavailable',
        'inactive',
        'expired',
        'blocked',
        'busy',
        'not_due',
        'lost_ownership',
        'retry_scheduled',
      ]),
    })
    .strict(),
]);
const rowSchema = z.object({ result: resultSchema });

export function createWorkspaceInboxProjectionStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkspaceInboxProjectionStore {
  const lease = acquireDatabasePool(config, runtime, { role: 'worker' });
  const lifetime = createInboxWriteLifetime(lease.close);
  const assertReady = (): void => {
    if (lifetime.isClosed() || !inboxWritesAvailable())
      throw new Error('Inbox projection store is unavailable');
  };
  return Object.freeze({
    projectNextPage: async (
      raw: WorkspaceInboxProjectionInput,
    ): Promise<WorkspaceInboxProjectionResult> => {
      assertReady();
      const input = workspaceInboxDeliveryInputSchema.parse(raw);
      input.signal.throwIfAborted();
      const activity = admitInboxWrite();
      if (activity === undefined) return { kind: 'busy' };
      const controller = new AbortController();
      const signal = AbortSignal.any([input.signal, controller.signal]);
      const timer = setTimeout(() => {
        controller.abort();
      }, 8_000);
      const leaseToken = randomUUID();
      const transaction = <T>(
        statement: string,
        values: readonly unknown[],
        decode: (row: unknown) => T,
      ) =>
        runInboxWriteTransaction(
          lease.pool,
          input.workspaceId,
          signal,
          activity,
          statement,
          values,
          decode,
          'projection',
        );
      const decode = (row: unknown) => rowSchema.parse(row).result;
      const work = async (): Promise<WorkspaceInboxProjectionResult> => {
        const claim = await transaction(
          'select app.claim_workspace_inbox_projection($1,$2,$3,$4,$5,$6) result',
          [
            input.workspaceId,
            input.sourceId,
            input.delivery.outboxEventId,
            input.delivery.payloadChecksum,
            input.workerId,
            leaseToken,
          ],
          decode,
        );
        if (claim.kind === 'uncertain') return { kind: 'outcome_unknown' };
        if (claim.kind === 'rolled_back')
          throw new Error('Inbox projection claim rejected');
        if (claim.value.kind !== 'owned') return claim.value;
        const values = [
          input.workspaceId,
          input.sourceId,
          leaseToken,
          claim.value.fenceToken,
        ];
        const page = await transaction(
          'select app.project_workspace_inbox_page($1,$2,$3,$4) result',
          values,
          decode,
        );
        if (page.kind === 'uncertain') return { kind: 'outcome_unknown' };
        if (page.kind === 'committed') {
          if (page.value.kind === 'owned')
            throw new Error('Invalid inbox projection result');
          return page.value;
        }
        // Only this transaction owner knows rollback was acknowledged. An
        // uncertain COMMIT never reaches failure accounting or a fresh command.
        const failure = await transaction(
          'select app.fail_workspace_inbox_projection($1,$2,$3,$4) result',
          values,
          decode,
        );
        if (failure.kind !== 'committed') return { kind: 'outcome_unknown' };
        if (failure.value.kind === 'owned')
          throw new Error('Invalid inbox projection failure result');
        return failure.value;
      };
      const { task, settled } = lifetime.observe(controller, activity, work);
      let onAbort: (() => void) | undefined;
      try {
        const canceled = new Promise<WorkspaceInboxProjectionResult>(
          (resolve) => {
            onAbort = () => {
              resolve({ kind: 'outcome_unknown' });
            };
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          },
        );
        const result = await Promise.race([task, canceled]);
        await withinInboxWriteSettlement(settled);
        return result;
      } finally {
        clearTimeout(timer);
        if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
      }
    },
    checkReadiness: async (signal?: AbortSignal): Promise<void> => {
      assertReady();
      await checkInboxProjectionReadiness(
        lease.pool,
        config.ownerRole,
        config.workerRuntimeRole,
        signal,
      );
      assertReady();
    },
    whenIdle: lifetime.whenIdle,
    close: lifetime.close,
  });
}
