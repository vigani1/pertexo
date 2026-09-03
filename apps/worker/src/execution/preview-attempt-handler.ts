import {
  canonicalOutboxPayloadChecksum,
  isValidStoredExecutionOutput,
} from '@pertexo/database/execution';
import {
  jobIdForOutboxEvent,
  type QueueDelivery,
  type QueueHandlerContext,
} from '@pertexo/queue';
import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
import { NodeDispatchEvidenceError } from '@pertexo/node-sdk/server';
import type {
  PreviewAttemptLease,
  PreviewClaimResult,
  PreviewCompletionResult,
  PreviewHeartbeatResult,
  PreviewTerminalOutcome,
  PreviewDelivery,
} from '@pertexo/database/execution';
import type {
  NodeAttemptCapabilityContext,
  NodeAttemptRuntimeCapabilityFactories,
} from './node-attempt-handler.js';
import type {
  PreviewTelemetry,
  PreviewTerminalStatus,
} from './preview-telemetry.js';
import { waitForSupervisorDelay } from '../runtime/abortable-delay.js';

type PreviewQueueDelivery = Extract<
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
      connectionFence?: Readonly<{
        connectionId: string;
        expectedProviderKey: string;
        expectedAuthType: string;
        secretVersionId: string;
      }>;
      providerDispatchBinding?: string;
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
      delivery: { outboxEventId: string; payloadChecksum: string };
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
  ): Promise<PreviewInvocationOutcome>;
}

export type PreviewInvocationOutcome =
  | Readonly<{ output: unknown; status: 'succeeded' }>
  | Exclude<PreviewTerminalOutcome, { readonly status: 'succeeded' }>;

export type PreviewAttemptHandlerResult = Readonly<{
  kind: 'duplicate' | 'committed';
}>;

export interface PreviewAttemptHandler {
  handle(
    delivery: PreviewQueueDelivery,
    context: QueueHandlerContext,
  ): Promise<PreviewAttemptHandlerResult>;
}

type PreviewCapabilityContext = NodeAttemptCapabilityContext &
  Readonly<{
    previewAttemptId: string;
    previewRunId: string;
  }>;

export type PreviewRuntimeCapabilityFactories =
  NodeAttemptRuntimeCapabilityFactories;

export interface PreviewAttemptHandlerDependencies {
  heartbeatIntervalMillis: number;
  invoker: PreviewNodeInvoker;
  leaseDurationSeconds: number;
  runStore: PreviewAttemptRunStore;
  runtimeCapabilities?: PreviewRuntimeCapabilityFactories;
  telemetry?: PreviewTelemetry;
  workerId: string;
}

class PreviewAttemptStateError extends Error {
  public override readonly name = 'PreviewAttemptStateError';
  public constructor(readonly code: string) {
    super(`Preview attempt delivery cannot execute: ${code}`);
  }
}

function deadlineExceededOutcome(
  lease: PreviewAttemptLease,
  dispatched: boolean,
): PreviewTerminalOutcome {
  return lease.sideEffectClass !== 'safe' && dispatched
    ? Object.freeze({
        safeErrorCode: 'preview.outcome_unknown',
        status: 'outcome_unknown',
      })
    : Object.freeze({
        safeErrorCode: 'preview.deadline_exceeded',
        status: 'timed_out',
      });
}

async function completeOutcome(
  dependencies: PreviewAttemptHandlerDependencies,
  lease: PreviewAttemptLease,
  outcome: PreviewInvocationOutcome,
  delivery: { outboxEventId: string; payloadChecksum: string },
  dispatched: boolean,
): Promise<PreviewAttemptHandlerResult> {
  if (
    outcome.status === 'canceled' &&
    lease.sideEffectClass !== 'safe' &&
    dispatched
  ) {
    outcome = Object.freeze({
      safeErrorCode: 'preview.outcome_unknown',
      status: 'outcome_unknown',
    });
  }
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
      return committedTerminal(
        dependencies,
        lease,
        'failed',
        dispatched,
        await dependencies.runStore.complete({
          delivery,
          lease,
          outcome: {
            safeErrorCode: 'preview.output_invalid',
            status: 'failed',
          },
          workerId: dependencies.workerId,
        }),
      );
    }
    return committedTerminal(
      dependencies,
      lease,
      'succeeded',
      dispatched,
      await dependencies.runStore.complete({
        delivery,
        lease,
        outcome: {
          output: stored,
          status: 'succeeded',
        },
        workerId: dependencies.workerId,
      }),
    );
  }
  return committedTerminal(
    dependencies,
    lease,
    outcome.status,
    dispatched,
    await dependencies.runStore.complete({
      delivery,
      lease,
      outcome,
      workerId: dependencies.workerId,
    }),
  );
}

function committed(
  result: PreviewCompletionResult,
): PreviewAttemptHandlerResult {
  return Object.freeze({ kind: result.kind });
}

function committedTerminal(
  dependencies: PreviewAttemptHandlerDependencies,
  lease: PreviewAttemptLease,
  status: PreviewTerminalStatus,
  dispatched: boolean,
  result: PreviewCompletionResult,
): PreviewAttemptHandlerResult {
  if (result.kind === 'committed') {
    const connectionRefs = lease.executableNode.connectionRefs;
    try {
      dependencies.telemetry?.recordTerminal({
        mayContactProvider: lease.mayContactProvider,
        mayCauseExternalSideEffect: lease.mayCauseExternalSideEffect,
        ...(lease.operationKey === undefined
          ? {}
          : { operationKey: lease.operationKey }),
        outcome: status,
        possiblyDispatched: dispatched,
        ...(lease.providerKey === undefined
          ? {}
          : { providerKey: lease.providerKey }),
        sideEffectClass: lease.sideEffectClass,
        source: 'execution',
        usesConnection:
          typeof connectionRefs === 'object' &&
          connectionRefs !== null &&
          Object.keys(connectionRefs).length > 0,
      });
    } catch {
      // Diagnostics cannot change a committed terminal transition.
    }
  }
  return committed(result);
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
      delivery: PreviewQueueDelivery,
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
      const claimDelivery = {
        outboxEventId: delivery.data.outboxEventId,
        payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
      };
      if (Date.now() >= lease.executionDeadlineAt.getTime())
        return committedTerminal(
          dependencies,
          lease,
          deadlineExceededOutcome(lease, false).status,
          false,
          await dependencies.runStore.complete({
            delivery: claimDelivery,
            lease,
            outcome: deadlineExceededOutcome(lease, false),
            workerId: dependencies.workerId,
          }),
        );

      const capabilityContext = Object.freeze({
        artifactRetentionDeadline: lease.retentionExpiresAt,
        attemptId: lease.previewAttemptId,
        attemptNumber: 1,
        invocationKey: `preview:${lease.nodeId}`,
        nodeId: lease.nodeId,
        nodeRunId: lease.previewRunId,
        previewAttemptId: lease.previewAttemptId,
        previewRunId: lease.previewRunId,
        runId: lease.previewRunId,
        workerId: dependencies.workerId,
        workspaceId: lease.workspaceId,
      });
      const connections =
        dependencies.runtimeCapabilities?.connections?.(capabilityContext);
      const artifacts =
        dependencies.runtimeCapabilities?.artifacts?.(capabilityContext);
      let dispatched = false;
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
        ...(lease.providerDispatchBinding === undefined
          ? {}
          : { providerDispatchBinding: lease.providerDispatchBinding }),
        ...(lease.providerDispatchUnresolved === undefined
          ? {}
          : { providerDispatchUnresolved: true as const }),
        ...(connections === undefined ? {} : { connections }),
        ...(artifacts === undefined ? {} : { artifacts }),
        beforeDispatch: async (
          input?: Parameters<NodeExecutionRuntime['beforeDispatch']>[0],
        ): Promise<void> => {
          if (dispatched)
            throw new PreviewAttemptStateError('duplicate_dispatch');
          try {
            await dependencies.runStore.markDispatched({
              lease,
              ...(input?.connectionFence === undefined
                ? {}
                : { connectionFence: input.connectionFence }),
              ...(input?.providerDispatchBinding === undefined
                ? {}
                : {
                    providerDispatchBinding: input.providerDispatchBinding,
                  }),
              signal: context.signal,
              workerId: dependencies.workerId,
            });
          } catch (error: unknown) {
            if (
              error instanceof Error &&
              'code' in error &&
              error.code === 'connection_fence_failed'
            )
              throw new NodeDispatchEvidenceError(
                'provider_connection_fence_failed',
              );
            if (
              error instanceof Error &&
              'code' in error &&
              error.code === 'dispatch_binding_mismatch'
            )
              throw new NodeDispatchEvidenceError(
                'provider_dispatch_binding_mismatch',
              );
            throw error;
          }
          dispatched = true;
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
      const deadlineTimer = setTimeout(
        () => {
          executionAbort.abort();
          notifyDeadline?.();
        },
        Math.max(0, lease.executionDeadlineAt.getTime() - Date.now()),
      );
      type HeartbeatEnd = 'stopped' | 'lease_lost';
      let endHeartbeat: ((end: HeartbeatEnd) => void) | undefined;
      const heartbeatDone = new Promise<HeartbeatEnd>((resolve) => {
        endHeartbeat = resolve;
      });
      let notifyLeaseFailure: ((error: unknown) => void) | undefined;
      const leaseFailure = new Promise<
        Readonly<{
          error: unknown;
          kind: 'lease_failure';
        }>
      >((resolve) => {
        notifyLeaseFailure = (error: unknown): void => {
          resolve({ error, kind: 'lease_failure' });
        };
      });
      void (async (): Promise<void> => {
        while (!heartbeatSignal.aborted) {
          await waitForSupervisorDelay(
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
          } catch (error: unknown) {
            // A lost lease cannot be repaired mid-flight; the durable
            // reconciliation path owns the truthful terminal state.
            executionAbort.abort();
            notifyLeaseFailure?.(error);
            endHeartbeat?.('lease_lost');
            return;
          }
          if (Date.now() >= beat.runExecutionDeadlineAt.getTime()) {
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
          | { kind: 'outcome'; outcome: PreviewInvocationOutcome }
          | { error: unknown; kind: 'lease_failure' };
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
          leaseFailure,
        ]);
        if (raced === 'deadline')
          return committedTerminal(
            dependencies,
            lease,
            deadlineExceededOutcome(lease, dispatched).status,
            dispatched,
            await dependencies.runStore.complete({
              delivery: claimDelivery,
              lease,
              outcome: deadlineExceededOutcome(lease, dispatched),
              workerId: dependencies.workerId,
            }),
          );
        if (raced.kind === 'error' || raced.kind === 'lease_failure')
          throw raced.error;
        // A result that resolved before the deadline remains truthful even
        // if the heartbeat observed expiry moments later.
        return await completeOutcome(
          dependencies,
          lease,
          raced.outcome,
          claimDelivery,
          dispatched,
        );
      } finally {
        clearTimeout(deadlineTimer);
        heartbeatStop.abort();
        await heartbeatDone;
      }
    },
  });
}
