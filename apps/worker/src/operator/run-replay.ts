import { CallableInputInvalidError } from '@pertexo/workflow-model';
import {
  canonicalOutboxPayloadChecksum,
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
} from '@pertexo/core/outbox';
import {
  createOperatorRunReplayStore,
  OperatorRunReplayMismatchError,
  OperatorRunReplayNotExecutableError,
  type OperatorRunReplayStore,
} from '@pertexo/core/operator';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import {
  unrecoverableQueueError,
  type QueueDelivery,
  type QueueHandlerContext,
} from '@pertexo/queue/server';
import {
  composeExecutableCatalog,
  WorkflowEngineError,
} from '@pertexo/workflow-engine/server';
import { initialCheckpointFactory } from '@pertexo/core/runs';

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
    catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
  });
  return createOperatorRunReplayStore(
    database,
    (projection) => {
      try {
        return checkpointFactory(projection);
      } catch (error: unknown) {
        if (error instanceof WorkflowEngineError)
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
        if (error instanceof CallableInputInvalidError) {
          await store.fail({
            commandId: delivery.data.commandId,
            safeErrorCode: 'input_invalid',
            workspaceId: delivery.data.workspaceId,
          });
          throw unrecoverableQueueError(
            'Replay input does not match the workflow input contract. Correct the input and submit a new command ID.',
          );
        }
        if (error instanceof OperatorRunReplayNotExecutableError) {
          await store.fail({
            commandId: delivery.data.commandId,
            safeErrorCode: 'version_not_executable',
            workspaceId: delivery.data.workspaceId,
          });
          throw unrecoverableQueueError('Run replay target is not executable');
        }
        if (
          error instanceof OperatorRunReplayMismatchError ||
          error instanceof InboxChecksumMismatchError ||
          error instanceof InboxReceiptUnavailableError
        )
          throw unrecoverableQueueError(
            'Run replay failed durable state verification',
          );
        throw error;
      }
    },
  });
}
