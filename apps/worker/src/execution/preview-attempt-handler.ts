import {
  canonicalOutboxPayloadChecksum,
  isValidStoredExecutionOutput,
  PreviewAttemptStateError,
} from '@pertexo/database/execution';
import type { QueueDelivery, QueueHandlerContext } from '@pertexo/queue';
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
import type { NodeExecutionCapabilityFactories } from './node-execution-capabilities.js';
import { nodeExecutionOptionalFields } from './node-execution-runtime-fields.js';
import type {
  PreviewTelemetry,
  PreviewTerminalStatus,
} from './preview-telemetry.js';
import { startPreviewAttemptSupervisor } from './preview-attempt-supervisor.js';

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
  close?(): Promise<void>;
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

export type PreviewRuntimeCapabilityFactories =
  NodeExecutionCapabilityFactories;

export interface PreviewAttemptHandlerDependencies {
  heartbeatIntervalMillis: number;
  invoker: PreviewNodeInvoker;
  leaseDurationSeconds: number;
  runStore: PreviewAttemptRunStore;
  runtimeCapabilities?: PreviewRuntimeCapabilityFactories;
  telemetry?: PreviewTelemetry;
  workerId: string;
}

export class PreviewAttemptHandlerStateError extends Error {
  public override readonly name = 'PreviewAttemptHandlerStateError';
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
  completionSignal: AbortSignal,
): Promise<PreviewAttemptHandlerResult> {
  let terminalOutcome: PreviewTerminalOutcome;
  if (
    outcome.status === 'canceled' &&
    lease.sideEffectClass !== 'safe' &&
    dispatched
  )
    terminalOutcome = Object.freeze({
      safeErrorCode: 'preview.outcome_unknown',
      status: 'outcome_unknown',
    });
  else if (outcome.status === 'succeeded') {
    // Executor payloads are raw JSON; the durable contract is the bounded
    // stored-value envelope. Large raw values must be written through the
    // artifact capability first and represented here by a bounded reference.
    const stored = {
      kind: 'inline',
      schemaVersion: 1,
      value: outcome.output,
    } as unknown;
    terminalOutcome = isValidStoredExecutionOutput(stored)
      ? { output: stored, status: 'succeeded' }
      : { safeErrorCode: 'preview.output_invalid', status: 'failed' };
  } else terminalOutcome = outcome;
  const result = await dependencies.runStore.complete({
    delivery,
    lease,
    outcome: terminalOutcome,
    signal: completionSignal,
    workerId: dependencies.workerId,
  });
  return committedTerminal(
    dependencies,
    lease,
    terminalOutcome.status,
    dispatched,
    result,
  );
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
  return Object.freeze({ kind: result.kind });
}

type PreviewExecutionEnvironment = Readonly<{
  runtime: NodeExecutionRuntime;
  wasDispatched(): boolean;
}>;

function createPreviewExecutionEnvironment(
  dependencies: PreviewAttemptHandlerDependencies,
  lease: PreviewAttemptLease,
  executionSignal: AbortSignal,
): PreviewExecutionEnvironment {
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
  let dispatchState: 'not_started' | 'marking' | 'marked' = 'not_started';
  const runtime: NodeExecutionRuntime = Object.freeze({
    workspaceId: lease.workspaceId,
    runId: lease.previewRunId,
    nodeRunId: lease.previewRunId,
    attemptId: lease.previewAttemptId,
    attemptNumber: 1,
    nodeId: lease.nodeId,
    invocationKey: `preview:${lease.nodeId}`,
    sideEffectClass: lease.sideEffectClass,
    ...nodeExecutionOptionalFields(lease, connections, artifacts),
    beforeDispatch: async (
      input?: Parameters<NodeExecutionRuntime['beforeDispatch']>[0],
    ): Promise<void> => {
      if (dispatchState !== 'not_started')
        throw new PreviewAttemptHandlerStateError('duplicate_dispatch');
      executionSignal.throwIfAborted();
      // Reserve the sole dispatch permission before awaiting durable authority.
      // A failed marker is uncertain and never reopens the provider-I/O gate.
      dispatchState = 'marking';
      try {
        await dependencies.runStore.markDispatched({
          lease,
          ...(input?.connectionFence === undefined
            ? {}
            : { connectionFence: input.connectionFence }),
          ...(input?.providerDispatchBinding === undefined
            ? {}
            : { providerDispatchBinding: input.providerDispatchBinding }),
          signal: executionSignal,
          workerId: dependencies.workerId,
        });
      } catch (error: unknown) {
        let durableCode: string | undefined;
        try {
          if (error instanceof PreviewAttemptStateError)
            durableCode = error.code;
        } catch {
          // Hostile unknown values cannot claim a durable state-error code.
        }
        if (durableCode === 'connection_fence_failed')
          throw new NodeDispatchEvidenceError(
            'provider_connection_fence_failed',
          );
        if (durableCode === 'dispatch_binding_mismatch')
          throw new NodeDispatchEvidenceError(
            'provider_dispatch_binding_mismatch',
          );
        throw error;
      }
      dispatchState = 'marked';
      executionSignal.throwIfAborted();
    },
  });
  return Object.freeze({
    runtime,
    wasDispatched: () => dispatchState === 'marked',
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
      delivery: PreviewQueueDelivery,
      context: QueueHandlerContext,
    ): Promise<PreviewAttemptHandlerResult> => {
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
      if (Date.now() >= lease.executionDeadlineAt.getTime()) {
        const deadlineOutcome = deadlineExceededOutcome(lease, false);
        return committedTerminal(
          dependencies,
          lease,
          deadlineOutcome.status,
          false,
          await dependencies.runStore.complete({
            delivery: claimDelivery,
            lease,
            outcome: deadlineOutcome,
            signal: context.signal,
            workerId: dependencies.workerId,
          }),
        );
      }

      const supervisor =
        startPreviewAttemptSupervisor<PreviewInvocationOutcome>({
          contextSignal: context.signal,
          heartbeatIntervalMillis: dependencies.heartbeatIntervalMillis,
          lease,
          leaseDurationSeconds: dependencies.leaseDurationSeconds,
          runStore: dependencies.runStore,
          workerId: dependencies.workerId,
        });
      try {
        const environment = createPreviewExecutionEnvironment(
          dependencies,
          lease,
          supervisor.executionSignal,
        );
        supervisor.executionSignal.throwIfAborted();
        const raced = await supervisor.race(
          dependencies.invoker.invoke({
            lease,
            runtime: environment.runtime,
            signal: supervisor.executionSignal,
          }),
        );
        const dispatched = environment.wasDispatched();
        if (raced === 'deadline') {
          const deadlineOutcome = deadlineExceededOutcome(lease, dispatched);
          return committedTerminal(
            dependencies,
            lease,
            deadlineOutcome.status,
            dispatched,
            await dependencies.runStore.complete({
              delivery: claimDelivery,
              lease,
              outcome: deadlineOutcome,
              signal: context.signal,
              workerId: dependencies.workerId,
            }),
          );
        }
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
          context.signal,
        );
      } finally {
        await supervisor.stop();
      }
    },
  });
}
