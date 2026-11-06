import { canonicalOutboxPayloadChecksum } from '@pertexo/core/outbox';
import type {
  PreviewAttemptLease,
  PreviewAttemptRunStore,
  PreviewClaimResult,
  PreviewCompletionResult,
  PreviewTerminalOutcome,
} from '@pertexo/core/previews';
import {
  isValidStoredExecutionOutput,
  PreviewAttemptStateError,
} from '@pertexo/core/previews';
import type { CodeDiagnostics } from '@pertexo/node-sdk';
import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
import { NodeDispatchEvidenceError } from '@pertexo/node-sdk/server';
import type { QueueDelivery, QueueHandlerContext } from '@pertexo/queue';
import type { NodeExecutionCapabilityFactories } from '../attempts/execution/capabilities.js';
import { nodeExecutionOptionalFields } from '../attempts/execution/runtime-fields.js';
import { parsePreviewFailure, previewDiagnostics } from './completion.js';
import { startPreviewAttemptSupervisor } from './supervisor.js';
import type { PreviewTelemetry, PreviewTerminalStatus } from './telemetry.js';
export type { PreviewAttemptRunStore } from '@pertexo/core/previews';

type PreviewQueueDelivery = Extract<
  QueueDelivery,
  { readonly name: 'execute-preview-attempt' }
>;

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
  { dispatched }: Readonly<{ dispatched: boolean }>,
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
  {
    outcome,
    delivery,
    dispatched,
    completionSignal,
    codeDiagnostics,
  }: Readonly<{
    outcome: PreviewInvocationOutcome;
    delivery: { outboxEventId: string; payloadChecksum: string };
    dispatched: boolean;
    completionSignal: AbortSignal;
    codeDiagnostics?: CodeDiagnostics | undefined;
  }>,
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
      value: outcome.output,
    } as unknown;
    terminalOutcome = isValidStoredExecutionOutput(stored)
      ? { output: stored, status: 'succeeded' }
      : { safeErrorCode: 'preview.output_invalid', status: 'failed' };
  } else terminalOutcome = parsePreviewFailure(outcome);
  const result = await dependencies.runStore.complete({
    delivery,
    lease,
    outcome: terminalOutcome,
    ...previewDiagnostics(codeDiagnostics),
    signal: completionSignal,
    workerId: dependencies.workerId,
  });
  return committedTerminal(dependencies, lease, {
    status: terminalOutcome.status,
    dispatched: dispatched,
    result: result,
  });
}

function committedTerminal(
  dependencies: PreviewAttemptHandlerDependencies,
  lease: PreviewAttemptLease,
  {
    status,
    dispatched,
    result,
  }: Readonly<{
    status: PreviewTerminalStatus;
    dispatched: boolean;
    result: PreviewCompletionResult;
  }>,
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
  codeDiagnostics(): CodeDiagnostics | undefined;
}>;

function createPreviewExecutionEnvironment(
  dependencies: PreviewAttemptHandlerDependencies,
  lease: PreviewAttemptLease,
  executionSignal: AbortSignal,
): PreviewExecutionEnvironment {
  const capabilityContext = Object.freeze({
    deadlineAt: lease.executionDeadlineAt,
    artifactRetentionDeadline: lease.retentionExpiresAt,
    attemptId: lease.previewAttemptId,
    attemptNumber: 1,
    invocationKey: `preview:${lease.nodeId}`,
    nodeId: lease.nodeId,
    nodeRunId: lease.previewRunId,
    previewAttemptId: lease.previewAttemptId,
    previewRunId: lease.previewRunId,
    fenceToken: lease.attemptFenceToken,
    runId: lease.previewRunId,
    workerId: dependencies.workerId,
    workspaceId: lease.workspaceId,
  });
  const connections =
    dependencies.runtimeCapabilities?.connections?.(capabilityContext);
  const artifacts =
    dependencies.runtimeCapabilities?.artifacts?.(capabilityContext);
  const webhookResponse =
    dependencies.runtimeCapabilities?.webhookResponse?.(capabilityContext);
  const dataTables =
    dependencies.runtimeCapabilities?.dataTables?.(capabilityContext);
  const runValues =
    dependencies.runtimeCapabilities?.runValues?.(capabilityContext);
  const code = dependencies.runtimeCapabilities?.code?.({
    ...capabilityContext,
    variables: lease.variables ?? {},
  });
  let diagnostics: CodeDiagnostics | undefined;
  let dispatchState: 'not_started' | 'marking' | 'marked' = 'not_started';
  const runtime: NodeExecutionRuntime = Object.freeze({
    deadlineAt: lease.executionDeadlineAt,
    ...(code === undefined ? {} : { code }),
    ...(dataTables === undefined ? {} : { dataTables }),
    ...(runValues === undefined ? {} : { runValues }),
    observeCodeDiagnostics: (value: CodeDiagnostics) => {
      // Safe previews do not need an external-dispatch marker. Completion
      // still fences this private data to the claimed preview attempt.
      diagnostics ??= value;
    },
    workspaceId: lease.workspaceId,
    runId: lease.previewRunId,
    nodeRunId: lease.previewRunId,
    attemptId: lease.previewAttemptId,
    attemptNumber: 1,
    nodeId: lease.nodeId,
    invocationKey: `preview:${lease.nodeId}`,
    sideEffectClass: lease.sideEffectClass,
    ...nodeExecutionOptionalFields(lease, connections, artifacts),
    ...(webhookResponse === undefined ? {} : { webhookResponse }),
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
        if (error instanceof PreviewAttemptStateError) {
          if (error.code === 'connection_fence_failed')
            throw new NodeDispatchEvidenceError(
              'provider_connection_fence_failed',
            );
          if (error.code === 'dispatch_binding_mismatch')
            throw new NodeDispatchEvidenceError(
              'provider_dispatch_binding_mismatch',
            );
        }
        throw error;
      }
      dispatchState = 'marked';
      executionSignal.throwIfAborted();
    },
  });
  return Object.freeze({
    runtime,
    wasDispatched: () => dispatchState === 'marked',
    codeDiagnostics: () => diagnostics,
  });
}

export function createPreviewAttemptHandler(
  dependencies: PreviewAttemptHandlerDependencies,
): PreviewAttemptHandler {
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
        const deadlineOutcome = deadlineExceededOutcome(lease, {
          dispatched: false,
        });
        return committedTerminal(dependencies, lease, {
          status: deadlineOutcome.status,
          dispatched: false,
          result: await dependencies.runStore.complete({
            delivery: claimDelivery,
            lease,
            outcome: deadlineOutcome,
            signal: context.signal,
            workerId: dependencies.workerId,
          }),
        });
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
          const deadlineOutcome = deadlineExceededOutcome(lease, {
            dispatched: dispatched,
          });
          return committedTerminal(dependencies, lease, {
            status: deadlineOutcome.status,
            dispatched: dispatched,
            result: await dependencies.runStore.complete({
              delivery: claimDelivery,
              lease,
              outcome: deadlineOutcome,
              signal: context.signal,
              workerId: dependencies.workerId,
            }),
          });
        }
        if (raced.kind === 'error' || raced.kind === 'lease_failure')
          throw raced.error;
        // A result that resolved before the deadline remains truthful even
        // if the heartbeat observed expiry moments later.
        return await completeOutcome(dependencies, lease, {
          outcome: raced.outcome,
          delivery: claimDelivery,
          dispatched: dispatched,
          completionSignal: context.signal,
          codeDiagnostics: environment.codeDiagnostics(),
        });
      } finally {
        await supervisor.stop();
      }
    },
  });
}
