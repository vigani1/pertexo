import { canonicalOutboxPayloadChecksum } from '@pertexo/database/outbox';
import type { RunAdvanceInput, RunAdvanceResult } from '@pertexo/database/runs';
import type {
  QueueDelivery,
  QueueHandlerContext,
  RunEventNotificationPublisher,
} from '@pertexo/queue';
import { WorkflowEngineError } from '@pertexo/workflow-engine';

import type { CoordinatorTelemetry } from './coordinator-telemetry.js';

type AdvanceWorkflowDelivery = Extract<
  QueueDelivery,
  { readonly name: 'advance-workflow-run' }
>;

export type CoordinatorHandlerResult = Readonly<{
  kind: 'already_committed' | 'committed' | 'deferred' | 'no_change';
  revision: number;
}>;

export type CoordinatorHandlerStateErrorCode =
  | 'capacity_exceeded'
  | 'not_executable'
  | 'not_found'
  | 'unsupported_checkpoint';

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
  /** `advanceRun` bound to its store and engine settings. */
  advance(input: RunAdvanceInput): Promise<RunAdvanceResult>;
  notifications?: RunEventNotificationPublisher;
  telemetry?: CoordinatorTelemetry;
}>;

async function advanceOrStateError(
  dependencies: CoordinatorHandlerDependencies,
  input: RunAdvanceInput,
): Promise<RunAdvanceResult> {
  try {
    return await dependencies.advance(input);
  } catch (error: unknown) {
    if (
      error instanceof WorkflowEngineError &&
      (error.code === 'checkpoint_invalid' ||
        error.code === 'checkpoint_unsupported')
    )
      throw new CoordinatorHandlerStateError('unsupported_checkpoint');
    throw error;
  }
}

export function createCoordinatorHandler(
  dependencies: CoordinatorHandlerDependencies,
): CoordinatorHandler {
  return Object.freeze({
    handle: async (
      delivery: AdvanceWorkflowDelivery,
      context: QueueHandlerContext,
    ): Promise<CoordinatorHandlerResult> => {
      const identity = Object.freeze({
        workspaceId: delivery.data.workspaceId,
        runId: delivery.data.runId,
      });
      const result = await advanceOrStateError(dependencies, {
        ...identity,
        delivery: {
          outboxEventId: delivery.data.outboxEventId,
          payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
        },
        ...(delivery.data.traceparent === undefined
          ? {}
          : { traceparent: delivery.data.traceparent }),
        signal: context.signal,
      });
      if (!('revision' in result))
        throw new CoordinatorHandlerStateError(result.kind);
      if (result.kind === 'committed') {
        if (result.scheduleToStartSeconds !== undefined) {
          try {
            dependencies.telemetry?.scheduleStarted(
              result.scheduleToStartSeconds,
            );
          } catch {
            // Diagnostics cannot change durable workflow truth.
          }
        }
        await publishResync(dependencies.notifications, identity);
      }
      return Object.freeze({ kind: result.kind, revision: result.revision });
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
