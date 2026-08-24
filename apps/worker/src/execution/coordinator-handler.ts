import type {
  CoordinatorRunStore,
  PublishedWorkflowReader,
  PublishedWorkflowV2Projection,
} from '@pertexo/database';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database';
import {
  jobIdForOutboxEvent,
  type QueueDelivery,
  type QueueHandlerContext,
  type RunEventNotificationPublisher,
} from '@pertexo/queue';
import type { WorkflowTransitionPlan } from '@pertexo/workflow-engine';

type AdvanceWorkflowDelivery = Extract<
  QueueDelivery,
  { readonly name: 'advance-workflow-run' }
>;

export interface CoordinatorAdvanceEngine {
  advance(
    input: Readonly<{
      runId: string;
      workflowVersionId: string;
      projection: PublishedWorkflowV2Projection;
      checkpoint: unknown;
      observations: readonly unknown[];
      completedOutputs?: readonly unknown[];
      occurredAt: string;
      maximumAdmissions: number;
      signal: AbortSignal;
    }>,
  ): Promise<
    | Readonly<{ kind: 'no_change'; revision: number }>
    | Readonly<{ kind: 'transition'; plan: WorkflowTransitionPlan }>
  >;
}

export type CoordinatorHandlerResult = Readonly<{
  kind: 'already_committed' | 'committed' | 'no_change' | 'stale';
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
}>;

export function createCoordinatorHandler(
  dependencies: CoordinatorHandlerDependencies,
): CoordinatorHandler {
  return Object.freeze({
    handle: async (
      delivery: AdvanceWorkflowDelivery,
      context: QueueHandlerContext,
    ): Promise<CoordinatorHandlerResult> => {
      if (
        delivery.transport.jobId !==
        jobIdForOutboxEvent(delivery.data.outboxEventId)
      ) {
        throw new CoordinatorHandlerStateError('transport_identity_mismatch');
      }
      const durableDelivery = Object.freeze({
        outboxEventId: delivery.data.outboxEventId,
        payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
      });
      const loaded = await dependencies.runStore.loadAdvanceState({
        workspaceId: delivery.data.workspaceId,
        runId: delivery.data.runId,
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
      if (published.kind !== 'v2_projection') {
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
      const advanced = await dependencies.engine.advance({
        runId: loaded.state.runId,
        workflowVersionId: loaded.state.workflowVersionId,
        projection: published.workflowVersion,
        checkpoint: loaded.state.checkpoint,
        observations: loaded.state.observations,
        ...(loaded.state.completedOutputs === undefined
          ? {}
          : { completedOutputs: loaded.state.completedOutputs }),
        occurredAt: dependencies.clock.now(),
        maximumAdmissions: dependencies.maximumAdmissions,
        signal: context.signal,
      });
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
