import type {
  CoordinatorRunStore,
  PublishedWorkflowReader,
  PublishedWorkflowExecutableProjection,
  PublishedWorkflowV3Projection,
} from '@pertexo/database/execution';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/execution';
import type {
  QueueDelivery,
  QueueHandlerContext,
  RunEventNotificationPublisher,
} from '@pertexo/queue';
import type {
  WorkflowTransitionPlan,
  LoadCallableCompletion,
  LoadCoordinatorControlDeclaration,
} from '@pertexo/workflow-engine';
import type { CallableValueWorkStop } from '@pertexo/workflow-model/workflow-call-contract';
import type { CoordinatorAdvanceDelivery } from '@pertexo/database/execution';

import type { CoordinatorTelemetry } from './coordinator-telemetry.js';
import {
  advanceNativeCoordinator,
  type CoordinatorNativeValueWork,
} from './coordinator-native-demand-advance.js';

type AdvanceWorkflowDelivery = Extract<
  QueueDelivery,
  { readonly name: 'advance-workflow-run' }
>;

export interface CoordinatorAdvanceEngine {
  advance(
    input: Readonly<{
      runId: string;
      workflowVersionId: string;
      projection: PublishedWorkflowExecutableProjection;
      checkpoint: unknown;
      observations: readonly unknown[];
      completedOutputs?: readonly unknown[];
      controlDeclarations?: Extract<
        Awaited<ReturnType<CoordinatorRunStore['loadAdvanceState']>>,
        { kind: 'ready' }
      >['state']['controlDeclarations'];
      loadCoordinatorControlDeclaration?: LoadCoordinatorControlDeclaration;
      workflowCalls?: Extract<
        Awaited<ReturnType<CoordinatorRunStore['loadAdvanceState']>>,
        { kind: 'ready' }
      >['state']['workflowCalls'];
      calleeProjections?: readonly PublishedWorkflowV3Projection[];
      callableCompletion?: Extract<
        Awaited<ReturnType<CoordinatorRunStore['loadAdvanceState']>>,
        { kind: 'ready' }
      >['state']['callableCompletion'];
      loadCallableCompletion?: LoadCallableCompletion;
      occurredAt: string;
      maximumAdmissions: number;
      signal: AbortSignal;
    }>,
  ): Promise<
    | Readonly<{ kind: 'no_change'; revision: number }>
    | Readonly<{ kind: 'transition'; plan: WorkflowTransitionPlan }>
    | Readonly<{ kind: 'value_work_stopped'; stop: CallableValueWorkStop }>
  >;
}

export type CoordinatorHandlerResult = Readonly<{
  kind: 'already_committed' | 'committed' | 'deferred' | 'no_change' | 'stale';
  revision: number;
}>;

export type CoordinatorHandlerStateErrorCode =
  | 'capacity_exceeded'
  | 'commit_not_found'
  | 'identity_mismatch'
  | 'not_executable'
  | 'not_found'
  | 'transport_identity_mismatch'
  | 'unsupported_checkpoint'
  | 'workflow_non_executable'
  | 'workflow_not_found';

export class CoordinatorHandlerStateError extends Error {
  public override readonly name = 'CoordinatorHandlerStateError';

  public constructor(readonly code: CoordinatorHandlerStateErrorCode) {
    super(`Coordinator delivery cannot advance: ${code}`);
  }
}

/** Retryable queue error, not durable workflow-control or receipt authority. */
export class CoordinatorValueWorkStoppedError extends Error {
  public override readonly name = 'CoordinatorValueWorkStoppedError';
  public constructor(readonly stop: CallableValueWorkStop) {
    super(`Coordinator value work stopped: ${stop.kind}`);
  }
}

export type CoordinatorCallableCompletionLoader = (
  input: Readonly<{
    workspaceId: string;
    runId: string;
    workflowVersionId: string;
    delivery: CoordinatorAdvanceDelivery;
    demand: Parameters<LoadCallableCompletion>[0];
    signal: AbortSignal;
  }>,
) => ReturnType<LoadCallableCompletion>;

export interface CoordinatorHandler {
  handle(
    delivery: AdvanceWorkflowDelivery,
    context: QueueHandlerContext,
  ): Promise<CoordinatorHandlerResult>;
}

export type CoordinatorHandlerDependencies = Readonly<{
  clock: Readonly<{ now(): string }>;
  engine: CoordinatorAdvanceEngine;
  maximumAdmissions: number;
  notifications?: RunEventNotificationPublisher;
  reader: PublishedWorkflowReader;
  runStore: CoordinatorRunStore;
  telemetry?: CoordinatorTelemetry;
  loadCallableCompletion?: CoordinatorCallableCompletionLoader;
  nativeValueWork?: CoordinatorNativeValueWork;
}>;

export function createCoordinatorHandler(
  dependencies: CoordinatorHandlerDependencies,
): CoordinatorHandler {
  return Object.freeze({
    handle: async (
      delivery: AdvanceWorkflowDelivery,
      context: QueueHandlerContext,
    ): Promise<CoordinatorHandlerResult> => {
      const durableDelivery = Object.freeze({
        outboxEventId: delivery.data.outboxEventId,
        payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
      });
      const loaded = await dependencies.runStore.loadAdvanceState({
        workspaceId: delivery.data.workspaceId,
        runId: delivery.data.runId,
        delivery: durableDelivery,
        signal: context.signal,
      });
      if (loaded.kind !== 'ready') {
        throw new CoordinatorHandlerStateError(loaded.kind);
      }
      if (loaded.state.runId !== delivery.data.runId) {
        throw new CoordinatorHandlerStateError('identity_mismatch');
      }
      const published = await dependencies.reader.readForExecution({
        workspaceId: delivery.data.workspaceId,
        workflowVersionId: loaded.state.workflowVersionId,
        signal: context.signal,
      });
      if (
        published.kind !== 'v2_projection' &&
        published.kind !== 'v3_projection'
      ) {
        throw new CoordinatorHandlerStateError(
          published.kind === 'not_found'
            ? 'workflow_not_found'
            : 'workflow_non_executable',
        );
      }
      if (
        published.workflowVersion.id !== loaded.state.workflowVersionId ||
        published.workflowVersion.workspaceId !== delivery.data.workspaceId
      ) {
        throw new CoordinatorHandlerStateError('identity_mismatch');
      }
      const calleeProjections: PublishedWorkflowV3Projection[] = [];
      for (const versionId of new Set(
        loaded.state.workflowCalls?.declarations.map(
          ({ calleeVersionId }) => calleeVersionId,
        ) ?? [],
      )) {
        const callee = await dependencies.reader.readForExecution({
          workspaceId: delivery.data.workspaceId,
          workflowVersionId: versionId,
          signal: context.signal,
        });
        if (
          callee.kind !== 'v3_projection' ||
          callee.workflowVersion.id !== versionId ||
          callee.workflowVersion.workspaceId !== delivery.data.workspaceId
        )
          throw new CoordinatorHandlerStateError('workflow_non_executable');
        calleeProjections.push(callee.workflowVersion);
      }
      const advanceInput: Parameters<CoordinatorAdvanceEngine['advance']>[0] = {
        runId: loaded.state.runId,
        workflowVersionId: loaded.state.workflowVersionId,
        projection: published.workflowVersion,
        checkpoint: loaded.state.checkpoint,
        observations: loaded.state.observations,
        ...(loaded.state.workflowCalls === undefined
          ? {}
          : { workflowCalls: loaded.state.workflowCalls, calleeProjections }),
        ...(loaded.state.completedOutputs === undefined
          ? {}
          : { completedOutputs: loaded.state.completedOutputs }),
        ...(loaded.state.controlDeclarations === undefined
          ? {}
          : {
              controlDeclarations: loaded.state.controlDeclarations,
            }),
        ...(published.kind === 'v3_projection'
          ? {
              loadCallableCompletion: (demand, signal) =>
                dependencies.loadCallableCompletion?.({
                  workspaceId: delivery.data.workspaceId,
                  runId: loaded.state.runId,
                  workflowVersionId: loaded.state.workflowVersionId,
                  delivery: durableDelivery,
                  demand,
                  signal,
                }) ??
                Promise.resolve({
                  kind: 'stopped',
                  stop: { kind: 'unavailable', reason: 'source_read_failed' },
                }),
            }
          : loaded.state.callableCompletion === undefined
            ? {}
            : { callableCompletion: loaded.state.callableCompletion }),
        occurredAt: dependencies.clock.now(),
        maximumAdmissions: dependencies.maximumAdmissions,
        signal: context.signal,
      };
      const advanced =
        published.kind === 'v3_projection' &&
        dependencies.nativeValueWork !== undefined
          ? await advanceNativeCoordinator({
              engine: dependencies.engine,
              advance: advanceInput,
              workspaceId: delivery.data.workspaceId,
              delivery: durableDelivery,
              runStore: dependencies.runStore,
              valueWork: dependencies.nativeValueWork,
            })
          : await dependencies.engine.advance(advanceInput);
      if (advanced.kind === 'value_work_stopped')
        throw new CoordinatorValueWorkStoppedError(advanced.stop);
      if (advanced.kind === 'no_change') {
        await dependencies.runStore.acknowledgeAdvanceDelivery({
          workspaceId: delivery.data.workspaceId,
          runId: loaded.state.runId,
          delivery: durableDelivery,
          signal: context.signal,
        });
        return advanced;
      }
      const committed = await dependencies.runStore.commitAdvancePlan({
        delivery: durableDelivery,
        workspaceId: delivery.data.workspaceId,
        runId: loaded.state.runId,
        workflowVersionId: loaded.state.workflowVersionId,
        plan: advanced.plan,
        ...(delivery.data.traceparent === undefined
          ? {}
          : { traceparent: delivery.data.traceparent }),
        signal: context.signal,
      });
      if (committed.kind === 'not_found') {
        throw new CoordinatorHandlerStateError('commit_not_found');
      }
      if (
        committed.kind === 'committed' &&
        committed.scheduleToStartSeconds !== undefined
      ) {
        try {
          dependencies.telemetry?.scheduleStarted(
            committed.scheduleToStartSeconds,
          );
        } catch {
          // Diagnostics cannot change durable workflow truth.
        }
      }
      if (committed.kind === 'committed')
        await publishResync(dependencies.notifications, {
          workspaceId: delivery.data.workspaceId,
          runId: loaded.state.runId,
        });
      return Object.freeze({
        kind: committed.kind,
        revision: committed.revision,
      });
    },
  });
}

async function publishResync(
  notifications: RunEventNotificationPublisher | undefined,
  identity: Readonly<{ workspaceId: string; runId: string }>,
): Promise<void> {
  if (notifications === undefined) return;
  try {
    await notifications.resync(identity);
  } catch {
    // PostgreSQL is authoritative; a later hint or reconnect backfills events.
  }
}
