import {
  canonicalOutboxPayloadChecksum,
  NodeAttemptOutputInvalidError,
  type NodeAttemptInputs,
  type NodeAttemptLease,
  type NodeAttemptRunStore,
  type PublishedWorkflowReader,
  type PublishedWorkflowV2Projection,
} from '@pertexo/database';
import {
  jobIdForOutboxEvent,
  type QueueDelivery,
  type QueueHandlerContext,
  type RunEventNotificationPublisher,
} from '@pertexo/queue';
import type {
  NodeAttemptOutcome,
  NodeExecutionRegistry,
} from '@pertexo/workflow-engine';
import { WorkflowEngineError } from '@pertexo/workflow-engine';
import type {
  NodeArtifactRuntime,
  NodeConnectionRuntime,
  NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';

type AttemptDelivery = Extract<
  QueueDelivery,
  { readonly name: 'execute-node-attempt' }
>;

export interface PreparedNodeAttempt {
  readonly suspensionDurationSeconds?: number;
  readonly upstreamNodeOutputs: readonly Readonly<{
    nodeId: string;
    invocationKey: string;
  }>[];
  execute(
    input: Readonly<
      NodeAttemptInputs & {
        registry: NodeExecutionRegistry;
        runtime?: NodeExecutionRuntime;
        signal: AbortSignal;
      }
    >,
  ): Promise<NodeAttemptOutcome>;
}

export interface NodeAttemptExecutionEngine {
  prepare(
    input: Readonly<{
      lease: NodeAttemptLease;
      projection: PublishedWorkflowV2Projection;
    }>,
  ): PreparedNodeAttempt;
}

export type NodeAttemptHandlerResult = Readonly<{
  kind: 'duplicate' | 'committed';
}>;

export interface NodeAttemptHandler {
  handle(
    delivery: AttemptDelivery,
    context: QueueHandlerContext,
  ): Promise<NodeAttemptHandlerResult>;
}

export type NodeAttemptCapabilityContext = Readonly<{
  artifactRetentionDeadline?: Date;
  previewRunId?: string;
  workspaceId: string;
  runId: string;
  nodeRunId: string;
  attemptId: string;
  attemptNumber: number;
  nodeId: string;
  invocationKey: string;
  workerId: string;
}>;

export type NodeAttemptRuntimeCapabilityFactories = Readonly<{
  connections?: (
    context: NodeAttemptCapabilityContext,
  ) => NodeConnectionRuntime;
  artifacts?: (context: NodeAttemptCapabilityContext) => NodeArtifactRuntime;
}>;

export type NodeAttemptHandlerDependencies = Readonly<{
  engine: NodeAttemptExecutionEngine;
  heartbeatIntervalMillis: number;
  leaseDurationSeconds: number;
  notifications?: RunEventNotificationPublisher;
  reader: PublishedWorkflowReader;
  registry: NodeExecutionRegistry;
  runStore: NodeAttemptRunStore;
  runtimeCapabilities?: NodeAttemptRuntimeCapabilityFactories;
  workerId: string;
}>;

export class NodeAttemptHandlerStateError extends Error {
  public override readonly name = 'NodeAttemptHandlerStateError';
  public constructor(readonly code: string) {
    super(`Node attempt delivery cannot execute: ${code}`);
  }
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function waitForHeartbeat(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function completeControlOutcome(
  dependencies: NodeAttemptHandlerDependencies,
  lease: NodeAttemptLease,
  reason: 'canceled' | 'timed_out',
  delivery: AttemptDelivery,
  signal: AbortSignal,
  dispatched: boolean,
): Promise<NodeAttemptHandlerResult> {
  const outcomeUnknown = lease.sideEffectClass === 'unsafe' && dispatched;
  const completed = await dependencies.runStore.complete({
    lease,
    outcome: {
      status: outcomeUnknown ? 'outcome_unknown' : reason,
      safeErrorCode: outcomeUnknown
        ? 'execution.outcome_unknown'
        : reason === 'canceled'
          ? 'execution.canceled'
          : 'execution.deadline_exceeded',
    },
    ...(delivery.data.traceparent === undefined
      ? {}
      : { traceparent: delivery.data.traceparent }),
    signal,
  });
  return completionResult(dependencies, lease, completed.kind);
}

async function completionResult(
  dependencies: NodeAttemptHandlerDependencies,
  lease: NodeAttemptLease,
  kind: 'committed' | 'duplicate',
): Promise<NodeAttemptHandlerResult> {
  if (kind === 'committed' && dependencies.notifications !== undefined) {
    try {
      await dependencies.notifications.resync({
        workspaceId: lease.workspaceId,
        runId: lease.runId,
      });
    } catch {
      // PostgreSQL is authoritative; a later hint or reconnect backfills.
    }
  }
  return Object.freeze({ kind });
}

export function createNodeAttemptHandler(
  dependencies: NodeAttemptHandlerDependencies,
): NodeAttemptHandler {
  if (
    !Number.isSafeInteger(dependencies.heartbeatIntervalMillis) ||
    dependencies.heartbeatIntervalMillis < 10 ||
    dependencies.heartbeatIntervalMillis >=
      dependencies.leaseDurationSeconds * 1_000
  )
    throw new TypeError(
      'Node attempt heartbeat interval must be positive and shorter than its lease',
    );
  return Object.freeze({
    handle: async (
      delivery: AttemptDelivery,
      context: QueueHandlerContext,
    ): Promise<NodeAttemptHandlerResult> => {
      if (
        delivery.transport.jobId !==
        jobIdForOutboxEvent(delivery.data.outboxEventId)
      )
        throw new NodeAttemptHandlerStateError('transport_identity_mismatch');
      const claimed = await dependencies.runStore.claimDelivery({
        workspaceId: delivery.data.workspaceId,
        runId: delivery.data.runId,
        nodeRunId: delivery.data.nodeRunId,
        attemptId: delivery.data.attemptId,
        delivery: {
          outboxEventId: delivery.data.outboxEventId,
          payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
        },
        leaseDurationSeconds: dependencies.leaseDurationSeconds,
        workerId: dependencies.workerId,
        signal: context.signal,
      });
      if (claimed.kind === 'duplicate')
        return Object.freeze({ kind: 'duplicate' });
      const published = await dependencies.reader.readForExecution({
        workspaceId: delivery.data.workspaceId,
        workflowVersionId: claimed.lease.workflowVersionId,
        signal: context.signal,
      });
      if (published.kind !== 'v2_projection')
        throw new NodeAttemptHandlerStateError(
          published.kind === 'not_found'
            ? 'workflow_not_found'
            : 'workflow_non_executable',
        );
      if (
        published.workflowVersion.id !== claimed.lease.workflowVersionId ||
        published.workflowVersion.workspaceId !== delivery.data.workspaceId
      )
        throw new NodeAttemptHandlerStateError('identity_mismatch');
      const prepared = dependencies.engine.prepare({
        lease: claimed.lease,
        projection: published.workflowVersion,
      });
      const inputs = await dependencies.runStore.loadInputs({
        lease: claimed.lease,
        upstreamNodeOutputs: prepared.upstreamNodeOutputs,
        signal: context.signal,
      });
      if (inputs.abortRequested) {
        if (inputs.abortReason === undefined)
          throw new NodeAttemptHandlerStateError('control_reason_missing');
        return completeControlOutcome(
          dependencies,
          claimed.lease,
          inputs.abortReason,
          delivery,
          context.signal,
          false,
        );
      }
      if (claimed.lease.admissionKind === 'wait_resume') {
        if (inputs.resumeOutput === undefined)
          throw new NodeAttemptHandlerStateError('wait_resume_output_missing');
        const completed = await dependencies.runStore.complete({
          lease: claimed.lease,
          outcome: { status: 'succeeded', output: inputs.resumeOutput },
          ...(delivery.data.traceparent === undefined
            ? {}
            : { traceparent: delivery.data.traceparent }),
          signal: context.signal,
        });
        return completionResult(dependencies, claimed.lease, completed.kind);
      }
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
      let durableAbortReason: 'canceled' | 'timed_out' | undefined;
      let heartbeatFailure: unknown;
      const heartbeat = (async (): Promise<void> => {
        try {
          while (!heartbeatSignal.aborted) {
            await waitForHeartbeat(
              dependencies.heartbeatIntervalMillis,
              heartbeatSignal,
            );
            const result = await dependencies.runStore.heartbeat({
              lease: claimed.lease,
              leaseDurationSeconds: dependencies.leaseDurationSeconds,
              signal: heartbeatSignal,
            });
            if (result.abortRequested) {
              if (result.abortReason === undefined)
                throw new NodeAttemptHandlerStateError(
                  'control_reason_missing',
                );
              durableAbortReason = result.abortReason;
              executionAbort.abort();
              return;
            }
          }
        } catch (error: unknown) {
          if (!heartbeatStop.signal.aborted && !context.signal.aborted) {
            heartbeatFailure = error;
            executionAbort.abort();
          }
        }
      })();
      let dispatched = false;
      const capabilityContext: NodeAttemptCapabilityContext = Object.freeze({
        workspaceId: claimed.lease.workspaceId,
        runId: claimed.lease.runId,
        nodeRunId: claimed.lease.nodeRunId,
        attemptId: claimed.lease.attemptId,
        attemptNumber: claimed.lease.attemptNumber,
        nodeId: claimed.lease.nodeId,
        invocationKey: claimed.lease.invocationKey,
        workerId: claimed.lease.workerId,
      });
      const connections =
        dependencies.runtimeCapabilities?.connections?.(capabilityContext);
      const artifacts =
        dependencies.runtimeCapabilities?.artifacts?.(capabilityContext);
      const runtime: NodeExecutionRuntime = Object.freeze({
        workspaceId: claimed.lease.workspaceId,
        runId: claimed.lease.runId,
        nodeRunId: claimed.lease.nodeRunId,
        attemptId: claimed.lease.attemptId,
        attemptNumber: claimed.lease.attemptNumber,
        nodeId: claimed.lease.nodeId,
        invocationKey: claimed.lease.invocationKey,
        sideEffectClass: claimed.lease.sideEffectClass,
        ...(claimed.lease.providerIdempotencyKey === undefined
          ? {}
          : {
              providerIdempotencyKey: claimed.lease.providerIdempotencyKey,
            }),
        ...(connections === undefined ? {} : { connections }),
        ...(artifacts === undefined ? {} : { artifacts }),
        beforeDispatch: async (): Promise<void> => {
          if (dispatched)
            throw new NodeAttemptHandlerStateError('duplicate_dispatch');
          await dependencies.runStore.markDispatched({
            lease: claimed.lease,
            signal: executionSignal,
          });
          dispatched = true;
        },
      });
      const registry: NodeExecutionRegistry = Object.freeze({
        ...(dependencies.registry.dispatchMode === undefined
          ? {}
          : { dispatchMode: dependencies.registry.dispatchMode }),
        execute: async (
          request: Parameters<NodeExecutionRegistry['execute']>[0],
        ) => {
          const mode =
            dependencies.registry.dispatchMode?.(request) ?? 'before_execute';
          if (mode === 'before_execute') await runtime.beforeDispatch();
          const result = await dependencies.registry.execute({
            ...request,
            runtime,
          });
          if (mode === 'executor_controlled' && !dispatched)
            throw new NodeAttemptHandlerStateError('dispatch_evidence_missing');
          return result;
        },
      });
      try {
        const outcome = await prepared.execute({
          ...inputs,
          registry,
          runtime,
          signal: executionSignal,
        });
        try {
          const completed = await dependencies.runStore.complete({
            lease: claimed.lease,
            outcome:
              prepared.suspensionDurationSeconds === undefined
                ? { status: 'succeeded', output: outcome.output }
                : {
                    status: 'suspended',
                    output: outcome.output,
                    durationSeconds: prepared.suspensionDurationSeconds,
                  },
            ...(delivery.data.traceparent === undefined
              ? {}
              : { traceparent: delivery.data.traceparent }),
            signal: context.signal,
          });
          return await completionResult(
            dependencies,
            claimed.lease,
            completed.kind,
          );
        } catch (error: unknown) {
          if (!(error instanceof NodeAttemptOutputInvalidError)) throw error;
          const completed = await dependencies.runStore.complete({
            lease: claimed.lease,
            outcome: {
              status: 'failed',
              safeErrorCode: 'execution.output_invalid',
            },
            ...(delivery.data.traceparent === undefined
              ? {}
              : { traceparent: delivery.data.traceparent }),
            signal: context.signal,
          });
          return await completionResult(
            dependencies,
            claimed.lease,
            completed.kind,
          );
        }
      } catch (error: unknown) {
        if (durableAbortReason !== undefined)
          return await completeControlOutcome(
            dependencies,
            claimed.lease,
            durableAbortReason,
            delivery,
            context.signal,
            dispatched,
          );
        if (heartbeatFailure !== undefined)
          throw heartbeatFailure instanceof Error
            ? heartbeatFailure
            : new Error('Node attempt heartbeat failed');
        if (error instanceof NodeExecutorFailure) {
          const completed = await dependencies.runStore.complete({
            lease: claimed.lease,
            outcome: {
              status: 'executor_failure',
              failureKind: error.kind,
              errorKind: error.errorKind,
              possiblyDispatched: error.possiblyDispatched,
              safeErrorCode: `execution.${error.errorKind}`,
            },
            ...(delivery.data.traceparent === undefined
              ? {}
              : { traceparent: delivery.data.traceparent }),
            signal: context.signal,
          });
          return await completionResult(
            dependencies,
            claimed.lease,
            completed.kind,
          );
        }
        if (
          error instanceof WorkflowEngineError &&
          error.code === 'attempt_invalid'
        ) {
          const completed = await dependencies.runStore.complete({
            lease: claimed.lease,
            outcome: {
              status: 'failed',
              safeErrorCode: 'execution.attempt_invalid',
            },
            ...(delivery.data.traceparent === undefined
              ? {}
              : { traceparent: delivery.data.traceparent }),
            signal: context.signal,
          });
          return await completionResult(
            dependencies,
            claimed.lease,
            completed.kind,
          );
        }
        throw error;
      } finally {
        heartbeatStop.abort();
        await heartbeat;
      }
    },
  });
}
