import { canonicalOutboxPayloadChecksum } from '@pertexo/core/outbox';
import {
  createErrorWorkflowStore,
  ErrorWorkflowDeliveryMismatchError,
  ErrorWorkflowVersionUnavailableError,
  type ErrorWorkflowStore,
} from '@pertexo/core/runs';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { initialCheckpointFactory } from '@pertexo/core/execution';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import {
  composeExecutableCatalog,
  WorkflowEngineError,
} from '@pertexo/workflow-engine';
import {
  unrecoverableQueueError,
  type QueueDelivery,
  type QueueHandlerContext,
} from '@pertexo/queue';

function createStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): ErrorWorkflowStore {
  const prepare = initialCheckpointFactory({
    catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
  });
  return createErrorWorkflowStore(
    config,
    (projection) => {
      try {
        return prepare(projection);
      } catch (error) {
        if (error instanceof WorkflowEngineError)
          throw new ErrorWorkflowVersionUnavailableError();
        throw error;
      }
    },
    runtime,
  );
}
function createHandler(store: ErrorWorkflowStore) {
  return Object.freeze({
    handle: async (
      delivery: Extract<QueueDelivery, { name: 'start-error-workflow' }>,
      context: QueueHandlerContext,
    ) => {
      try {
        await store.dispatch({
          ...delivery.data,
          payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
          signal: context.signal,
        });
      } catch (error) {
        if (error instanceof ErrorWorkflowDeliveryMismatchError)
          throw unrecoverableQueueError(
            'Error workflow delivery failed durable transport verification',
          );
        throw error;
      }
    },
  });
}
export const errorWorkflowFactories = Object.freeze({
  store: createStore,
  handler: createHandler,
});
export type ErrorWorkflowHandler = ReturnType<typeof createHandler>;
