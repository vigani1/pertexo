import {
  canonicalOutboxPayloadChecksum,
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
} from '@pertexo/database/outbox';
import {
  createOperatorRunReplayStore,
  OperatorRunReplayMismatchError,
  OperatorRunReplayNotExecutableError,
  type OperatorRunReplayStore,
} from '@pertexo/database/operator';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { PLATFORM_REGISTRY_RELEASE } from '@pertexo/node-catalog';
import {
  unrecoverableQueueError,
  type QueueDelivery,
  type QueueHandlerContext,
} from '@pertexo/queue';
import {
  composeExecutableCompatibilityRelease,
  WorkflowEngineError,
} from '@pertexo/workflow-engine';
import { initialCheckpointFactory } from '@pertexo/execution';

export const operatorRunReplayFactories = Object.freeze({
  handler: createOperatorRunReplayHandler,
  store: createDatabaseOperatorRunReplayStore,
});

type ReplayDelivery = Extract<
  QueueDelivery,
  { readonly name: 'replay-workflow-run' }
>;

export function createDatabaseOperatorRunReplayStore(
  database: DatabaseConfig,
  runtime?: DatabaseRuntime,
): OperatorRunReplayStore {
  const checkpointFactory = initialCheckpointFactory({
    release: composeExecutableCompatibilityRelease(PLATFORM_REGISTRY_RELEASE),
  });
  return createOperatorRunReplayStore(
    database,
    (projection) => {
      try {
        return checkpointFactory(projection);
      } catch (error: unknown) {
        if (isErrorInstance(error, WorkflowEngineError))
          throw new OperatorRunReplayNotExecutableError();
        throw error;
      }
    },
    runtime,
  );
}

export function createOperatorRunReplayHandler(store: OperatorRunReplayStore) {
  return Object.freeze({
    handle: async (delivery: ReplayDelivery, context: QueueHandlerContext) => {
      try {
        return await store.replay({
          commandId: delivery.data.commandId,
          delivery: {
            outboxEventId: delivery.data.outboxEventId,
            payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
          },
          signal: context.signal,
          workspaceId: delivery.data.workspaceId,
        });
      } catch (error: unknown) {
        if (isErrorInstance(error, OperatorRunReplayNotExecutableError)) {
          await store.fail({
            commandId: delivery.data.commandId,
            safeErrorCode: 'version_not_executable',
            workspaceId: delivery.data.workspaceId,
          });
          throw unrecoverableQueueError('Run replay target is not executable');
        }
        if (
          isErrorInstance(error, OperatorRunReplayMismatchError) ||
          isErrorInstance(error, InboxChecksumMismatchError) ||
          isErrorInstance(error, InboxReceiptUnavailableError)
        )
          throw unrecoverableQueueError(
            'Run replay failed durable state verification',
          );
        throw error;
      }
    },
  });
}

function isErrorInstance<T extends Error>(
  value: unknown,
  constructor: abstract new (...arguments_: never[]) => T,
): value is T {
  try {
    return value instanceof constructor;
  } catch {
    return false;
  }
}
