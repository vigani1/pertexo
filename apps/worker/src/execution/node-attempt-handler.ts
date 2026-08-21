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
} from '@pertexo/queue';
import type {
  NodeAttemptOutcome,
  NodeExecutionRegistry,
} from '@pertexo/workflow-engine';
import { WorkflowEngineError } from '@pertexo/workflow-engine';

type AttemptDelivery = Extract<
  QueueDelivery,
  { readonly name: 'execute-node-attempt' }
>;

export interface PreparedNodeAttempt {
  readonly upstreamNodeIds: readonly string[];
  execute(
    input: Readonly<
      NodeAttemptInputs & {
        registry: NodeExecutionRegistry;
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

export type NodeAttemptHandlerDependencies = Readonly<{
  engine: NodeAttemptExecutionEngine;
  heartbeatIntervalMillis: number;
  leaseDurationSeconds: number;
  reader: PublishedWorkflowReader;
  registry: NodeExecutionRegistry;
  runStore: NodeAttemptRunStore;
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
): Promise<NodeAttemptHandlerResult> {
  const completed = await dependencies.runStore.complete({
    lease,
    outcome: {
      status: reason,
      safeErrorCode:
        reason === 'canceled'
          ? 'execution.canceled'
          : 'execution.deadline_exceeded',
    },
    ...(delivery.data.traceparent === undefined
      ? {}
      : { traceparent: delivery.data.traceparent }),
    signal,
  });
  return Object.freeze({
    kind: completed.kind === 'committed' ? 'committed' : 'duplicate',
  });
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
        upstreamNodeIds: prepared.upstreamNodeIds,
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
        );
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
      const registry: NodeExecutionRegistry = Object.freeze({
        execute: async (
          request: Parameters<NodeExecutionRegistry['execute']>[0],
        ) => {
          if (dispatched)
            throw new NodeAttemptHandlerStateError('duplicate_dispatch');
          await dependencies.runStore.markDispatched({
            lease: claimed.lease,
            signal: request.signal,
          });
          dispatched = true;
          return dependencies.registry.execute(request);
        },
      });
      try {
        const outcome = await prepared.execute({
          ...inputs,
          registry,
          signal: executionSignal,
        });
        try {
          const completed = await dependencies.runStore.complete({
            lease: claimed.lease,
            outcome: { status: 'succeeded', output: outcome.output },
            ...(delivery.data.traceparent === undefined
              ? {}
              : { traceparent: delivery.data.traceparent }),
            signal: context.signal,
          });
          return Object.freeze({
            kind: completed.kind === 'committed' ? 'committed' : 'duplicate',
          });
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
          return Object.freeze({
            kind: completed.kind === 'committed' ? 'committed' : 'duplicate',
          });
        }
      } catch (error: unknown) {
        if (durableAbortReason !== undefined)
          return await completeControlOutcome(
            dependencies,
            claimed.lease,
            durableAbortReason,
            delivery,
            context.signal,
          );
        if (heartbeatFailure !== undefined)
          throw heartbeatFailure instanceof Error
            ? heartbeatFailure
            : new Error('Node attempt heartbeat failed');
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
          return Object.freeze({
            kind: completed.kind === 'committed' ? 'committed' : 'duplicate',
          });
        }
        throw error;
      } finally {
        heartbeatStop.abort();
        await heartbeat;
      }
    },
  });
}
