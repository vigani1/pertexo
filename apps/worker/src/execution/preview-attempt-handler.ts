import {
  canonicalOutboxPayloadChecksum,
  isValidStoredExecutionOutput,
} from '@pertexo/database';
import {
  jobIdForOutboxEvent,
  type QueueDelivery,
  type QueueHandlerContext,
} from '@pertexo/queue';
import type {
  NodeArtifactRuntime,
  NodeConnectionRuntime,
  NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import type {
  PreviewAttemptLease,
  PreviewClaimResult,
  PreviewCompletionResult,
  PreviewHeartbeatResult,
  PreviewTerminalOutcome,
  PreviewDelivery,
} from '@pertexo/database';

type PreviewDelivery_ = Extract<
  QueueDelivery,
  { readonly name: 'execute-preview-attempt' }
>;

export interface PreviewAttemptRunStore {
  claim(
    input: Readonly<{
      delivery: PreviewDelivery;
      leaseDurationSeconds: number;
      previewAttemptId: string;
      previewRunId: string;
      signal?: AbortSignal;
      workerId: string;
      workspaceId: string;
    }>,
  ): Promise<PreviewClaimResult>;
  markDispatched(
    input: Readonly<{
      lease: Pick<
        PreviewAttemptLease,
        | 'attemptFenceToken'
        | 'previewAttemptId'
        | 'previewRunId'
        | 'workspaceId'
      >;
      signal?: AbortSignal;
      workerId: string;
    }>,
  ): Promise<'committed'>;
  heartbeat(
    input: Readonly<{
      lease: Pick<
        PreviewAttemptLease,
        | 'attemptFenceToken'
        | 'previewAttemptId'
        | 'previewRunId'
        | 'workspaceId'
      >;
      leaseDurationSeconds: number;
      signal?: AbortSignal;
      workerId: string;
    }>,
  ): Promise<PreviewHeartbeatResult>;
  complete(
    input: Readonly<{
      lease: Pick<
        PreviewAttemptLease,
        | 'attemptFenceToken'
        | 'previewAttemptId'
        | 'previewRunId'
        | 'workspaceId'
      >;
      outcome: PreviewTerminalOutcome;
      signal?: AbortSignal;
      workerId: string;
    }>,
  ): Promise<PreviewCompletionResult>;
}

/**
 * The single execution boundary for one pinned preview node. Implementations
 * own truthful outcome classification — including whether a provider effect
 * may already exist — because only they know the executor's dispatch
 * evidence contract.
 */
export interface PreviewNodeInvoker {
  invoke(
    input: Readonly<{
      lease: PreviewAttemptLease;
      runtime?: NodeExecutionRuntime;
      signal: AbortSignal;
    }>,
  ): Promise<PreviewTerminalOutcome>;
}

export type PreviewAttemptHandlerResult = Readonly<{
  kind: 'duplicate' | 'committed';
}>;

export interface PreviewAttemptHandler {
  handle(
    delivery: PreviewDelivery_,
    context: QueueHandlerContext,
  ): Promise<PreviewAttemptHandlerResult>;
}

export type PreviewCapabilityContext = Readonly<{
  attemptId: string;
  nodeId: string;
  previewAttemptId: string;
  previewRunId: string;
  workerId: string;
  workspaceId: string;
}>;

export type PreviewRuntimeCapabilityFactories = Readonly<{
  artifacts?: (context: PreviewCapabilityContext) => NodeArtifactRuntime;
  connections?: (context: PreviewCapabilityContext) => NodeConnectionRuntime;
}>;

export interface PreviewAttemptHandlerDependencies {
  heartbeatIntervalMillis: number;
  invoker: PreviewNodeInvoker;
  leaseDurationSeconds: number;
  runStore: PreviewAttemptRunStore;
  runtimeCapabilities?: PreviewRuntimeCapabilityFactories;
  workerId: string;
}

export class PreviewAttemptStateError extends Error {
  public override readonly name = 'PreviewAttemptStateError';
  public constructor(readonly code: string) {
    super(`Preview attempt delivery cannot execute: ${code}`);
  }
}

function deadlineExceededOutcome(): PreviewTerminalOutcome {
  return Object.freeze({
    safeErrorCode: 'preview.deadline_exceeded',
    status: 'timed_out',
  });
}

async function completeOutcome(
  dependencies: PreviewAttemptHandlerDependencies,
  lease: PreviewAttemptLease,
  outcome: PreviewTerminalOutcome,
): Promise<PreviewAttemptHandlerResult> {
  let completedOutcome = outcome;
  if (outcome.status === 'succeeded') {
    // Executor payloads are raw JSON; the durable contract is the bounded
    // stored-value envelope. Inline wrapping only in this checkpoint —
    // oversized responses fail closed here until artifact streaming for
    // previews composes its capability.
    const stored = {
      kind: 'inline',
      schemaVersion: 1,
      value: outcome.output,
    } as unknown;
    if (!isValidStoredExecutionOutput(stored)) {
      return committed(
        await dependencies.runStore.complete({
          lease,
          outcome: {
            safeErrorCode: 'preview.output_invalid',
            status: 'failed',
          },
          workerId: dependencies.workerId,
        }),
      );
    }
    completedOutcome = {
      output: stored,
      status: 'succeeded',
    } as PreviewTerminalOutcome;
  }
  return committed(
    await dependencies.runStore.complete({
      lease,
      outcome: completedOutcome,
      workerId: dependencies.workerId,
    }),
  );
}

function committed(
  result: PreviewCompletionResult,
): PreviewAttemptHandlerResult {
  return Object.freeze({ kind: result.kind });
}

function waitForHeartbeat(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createPreviewAttemptHandler(
  dependencies: PreviewAttemptHandlerDependencies,
): PreviewAttemptHandler {
  if (
    !Number.isSafeInteger(dependencies.heartbeatIntervalMillis) ||
    dependencies.heartbeatIntervalMillis < 10 ||
    dependencies.heartbeatIntervalMillis >=
      dependencies.leaseDurationSeconds * 1_000
  )
    throw new TypeError(
      'Preview attempt heartbeat interval must be positive and shorter than its lease',
    );
  return Object.freeze({
    handle: async (
      delivery: PreviewDelivery_,
      context: QueueHandlerContext,
    ): Promise<PreviewAttemptHandlerResult> => {
      if (
        delivery.transport.jobId !==
        jobIdForOutboxEvent(delivery.data.outboxEventId)
      )
        throw new PreviewAttemptStateError('transport_identity_mismatch');
      const claimed: PreviewClaimResult = await dependencies.runStore.claim({
        delivery: {
          outboxEventId: delivery.data.outboxEventId,
          // The transport payload mirrors acceptance byte-for-byte, so the
          // durable checksum is recomputed from the delivery itself.
          payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
        },
        leaseDurationSeconds: dependencies.leaseDurationSeconds,
        previewAttemptId: delivery.data.previewAttemptId,
        previewRunId: delivery.data.previewRunId,
        signal: context.signal,
        workerId: dependencies.workerId,
        workspaceId: delivery.data.workspaceId,
      });
      if (claimed.kind === 'duplicate')
        return Object.freeze({ kind: 'duplicate' });
      const lease = claimed.lease;

      const capabilityContext = Object.freeze({
        attemptId: lease.previewAttemptId,
        nodeId: lease.nodeId,
        previewAttemptId: lease.previewAttemptId,
        previewRunId: lease.previewRunId,
        workerId: dependencies.workerId,
        workspaceId: lease.workspaceId,
      });
      const connections =
        dependencies.runtimeCapabilities?.connections?.(capabilityContext);
      const artifacts =
        dependencies.runtimeCapabilities?.artifacts?.(capabilityContext);
      const runtime: NodeExecutionRuntime = Object.freeze({
        workspaceId: lease.workspaceId,
        runId: lease.previewRunId,
        nodeRunId: lease.previewRunId,
        attemptId: lease.previewAttemptId,
        attemptNumber: 1,
        nodeId: lease.nodeId,
        invocationKey: `preview:${lease.nodeId}`,
        sideEffectClass: lease.sideEffectClass,
        ...(lease.providerIdempotencyKey === undefined
          ? {}
          : { providerIdempotencyKey: lease.providerIdempotencyKey }),
        ...(connections === undefined ? {} : { connections }),
        ...(artifacts === undefined ? {} : { artifacts }),
        beforeDispatch: async (): Promise<void> => {
          await dependencies.runStore.markDispatched({
            lease,
            signal: context.signal,
            workerId: dependencies.workerId,
          });
        },
      });

      const executionAbort = new AbortController();
      const heartbeatStop = new AbortController();
      const heartbeatSignal = AbortSignal.any([
        context.signal,
        heartbeatStop.signal,
      ]);
      const executionSignal = AbortSignal.any([
        context.signal,
        executionAbort.signal,
      ]);
      let notifyDeadline: (() => void) | undefined;
      const deadlineHit = new Promise<'deadline'>((resolve) => {
        notifyDeadline = (): void => {
          resolve('deadline');
        };
      });
      type HeartbeatEnd = 'stopped' | 'lease_lost';
      let endHeartbeat: ((end: HeartbeatEnd) => void) | undefined;
      const heartbeatDone = new Promise<HeartbeatEnd>((resolve) => {
        endHeartbeat = resolve;
      });
      void (async (): Promise<void> => {
        while (!heartbeatSignal.aborted) {
          await waitForHeartbeat(
            dependencies.heartbeatIntervalMillis,
            heartbeatSignal,
          );
          let beat: PreviewHeartbeatResult;
          try {
            beat = await dependencies.runStore.heartbeat({
              lease,
              leaseDurationSeconds: dependencies.leaseDurationSeconds,
              signal: heartbeatSignal,
              workerId: dependencies.workerId,
            });
          } catch {
            // A lost lease cannot be repaired mid-flight; the durable
            // reconciliation path owns the truthful terminal state.
            executionAbort.abort();
            endHeartbeat?.('lease_lost');
            return;
          }
          if (Date.now() >= beat.runExpiresAt.getTime()) {
            executionAbort.abort();
            notifyDeadline?.();
            endHeartbeat?.('stopped');
            return;
          }
        }
        endHeartbeat?.('stopped');
      })();

      try {
        type RaceOutcome =
          | { error: unknown; kind: 'error' }
          | { kind: 'outcome'; outcome: PreviewTerminalOutcome };
        const raced = await Promise.race<RaceOutcome | 'deadline'>([
          dependencies.invoker
            .invoke({ lease, runtime, signal: executionSignal })
            .then(
              (outcome): RaceOutcome => ({
                kind: 'outcome',
                outcome,
              }),
              (error: unknown): RaceOutcome => ({ error, kind: 'error' }),
            ),
          deadlineHit,
        ]);
        if (raced === 'deadline')
          return committed(
            await dependencies.runStore.complete({
              lease,
              outcome: deadlineExceededOutcome(),
              workerId: dependencies.workerId,
            }),
          );
        if (raced.kind === 'error') throw raced.error;
        // A result that resolved before the deadline remains truthful even
        // if the heartbeat observed expiry moments later.
        return await completeOutcome(dependencies, lease, raced.outcome);
      } finally {
        heartbeatStop.abort();
        await heartbeatDone;
      }
    },
  });
}
