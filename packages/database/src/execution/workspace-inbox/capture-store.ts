import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/database-runtime.js';
import type {
  WorkspaceInboxCaptureInput,
  WorkspaceInboxCaptureStore,
  WorkspaceInboxCaptureResult,
} from './capture-contract.js';
import {
  runCaptureTransaction,
  type CaptureActivity,
} from './capture-transaction.js';
import { checkInboxCaptureReadiness } from './capture-readiness.js';

const inputSchema = z
  .object({
    workspaceId: z.uuid(),
    sourceId: z.uuid(),
    workerId: z.string().min(1).max(128),
    delivery: z
      .object({
        outboxEventId: z.uuid(),
        payloadChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict(),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();
const fenceSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
const resultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('captured'),
      audienceCount: z.string().regex(/^(0|[1-9][0-9]{0,18})$/u),
    })
    .strict(),
  z.object({ kind: z.literal('owned'), fenceToken: fenceSchema }).strict(),
  z
    .object({
      kind: z.enum([
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

// Hard feature-local process admission, not one slot per store/caller. Never
// released merely because an outward timeout won a Promise.race.
let admitted: object | undefined;
let disposalUnconfirmed = false;

function createActivity(): CaptureActivity &
  Readonly<{ settle(): Promise<void> }> {
  const pending = new Set<Promise<unknown>>();
  return {
    track: <T>(promise: Promise<T>): Promise<T> => {
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return promise;
    },
    failDisposal: () => {
      disposalUnconfirmed = true;
    },
    settle: async () => {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}

async function withinSettlement(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          disposalUnconfirmed = true;
          reject(new Error('Inbox capture disposal is unconfirmed'));
        }, 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createWorkspaceInboxCaptureStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkspaceInboxCaptureStore {
  const lease = acquireDatabasePool(config, runtime, { role: 'worker' });
  const operations = new Set<Promise<void>>();
  let closed = false;
  let cancel: AbortController | undefined;
  let closing: Promise<void> | undefined;
  const idle = async (): Promise<void> => {
    while (operations.size > 0) await Promise.all([...operations]);
  };
  const assertReady = (): void => {
    if (closed || disposalUnconfirmed)
      throw new Error('Inbox capture store is unavailable');
  };
  return Object.freeze({
    capture: async (
      raw: WorkspaceInboxCaptureInput,
    ): Promise<WorkspaceInboxCaptureResult> => {
      assertReady();
      const input = inputSchema.parse(raw);
      input.signal.throwIfAborted();
      if (admitted !== undefined) return { kind: 'busy' };
      const identity = {};
      admitted = identity;
      const activity = createActivity();
      const controller = new AbortController();
      cancel = controller;
      const signal = AbortSignal.any([input.signal, controller.signal]);
      const timer = setTimeout(() => {
        controller.abort();
      }, 10_000);
      const leaseToken = randomUUID();
      const transaction = <T>(
        statement: string,
        values: readonly unknown[],
        decode: (row: unknown) => T,
      ) =>
        runCaptureTransaction(
          lease.pool,
          input.workspaceId,
          signal,
          activity,
          statement,
          values,
          decode,
        );
      const decode = (row: unknown) => rowSchema.parse(row).result;
      const work = async (): Promise<WorkspaceInboxCaptureResult> => {
        const claim = await transaction(
          'select app.claim_workspace_inbox_capture($1,$2,$3,$4,$5,$6) result',
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
          throw new Error('Inbox capture claim rejected');
        if (claim.value.kind !== 'owned') return claim.value;
        const values = [
          input.workspaceId,
          input.sourceId,
          leaseToken,
          claim.value.fenceToken,
        ];
        const captured = await transaction(
          'select app.capture_workspace_inbox_audience($1,$2,$3,$4) result',
          values,
          decode,
        );
        if (captured.kind === 'uncertain') return { kind: 'outcome_unknown' };
        if (captured.kind === 'committed') {
          if (captured.value.kind === 'owned')
            throw new Error('Invalid inbox capture result');
          return captured.value;
        }
        // Only this transaction owner knows rollback was acknowledged. An
        // uncertain COMMIT never reaches failure accounting or a fresh command.
        const failure = await transaction(
          'select app.fail_workspace_inbox_capture($1,$2,$3,$4) result',
          values,
          decode,
        );
        if (failure.kind !== 'committed') return { kind: 'outcome_unknown' };
        if (failure.value.kind === 'owned')
          throw new Error('Invalid inbox capture failure result');
        return failure.value;
      };
      const task = work();
      const settled = task
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => activity.settle())
        .then(() => {
          if (admitted === identity) admitted = undefined;
          if (cancel === controller) cancel = undefined;
        });
      operations.add(settled);
      void settled.then(() => operations.delete(settled));
      let onAbort: (() => void) | undefined;
      try {
        const canceled = new Promise<WorkspaceInboxCaptureResult>((resolve) => {
          onAbort = () => {
            resolve({ kind: 'outcome_unknown' });
          };
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        const result = await Promise.race([task, canceled]);
        await withinSettlement(settled);
        return result;
      } finally {
        clearTimeout(timer);
        if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
      }
    },
    checkReadiness: async (signal?: AbortSignal): Promise<void> => {
      assertReady();
      await checkInboxCaptureReadiness(
        lease.pool,
        config.ownerRole,
        config.workerRuntimeRole,
        signal,
      );
      assertReady();
    },
    whenIdle: idle,
    close: (): Promise<void> => {
      closed = true;
      cancel?.abort();
      closing ??= Promise.resolve().then(async () => {
        const pending = idle();
        try {
          await withinSettlement(pending);
        } catch (error: unknown) {
          void pending.then(() => lease.close()).catch(() => undefined);
          throw error;
        }
        await lease.close();
      });
      return closing;
    },
  });
}
