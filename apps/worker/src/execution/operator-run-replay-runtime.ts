import {
  canonicalOutboxPayloadChecksum,
  createOperatorRunReplayStore,
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
  OperatorRunReplayMismatchError,
  OperatorRunReplayNotExecutableError,
  type DatabaseConfig,
  type DatabaseRuntime,
  type OperatorRunReplayStore,
} from '@pertexo/database/execution';
import {
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
} from '@pertexo/node-catalog';
import {
  unrecoverableQueueError,
  type QueueDelivery,
  type QueueHandlerContext,
} from '@pertexo/queue';
import {
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseHistory,
  createExecutableCompatibilityReleaseSupport,
  WorkflowEngineError,
} from '@pertexo/workflow-engine';
import { createInitialCheckpoint } from '@pertexo/execution';

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
  const releaseHistory = createExecutableCompatibilityReleaseHistory(
    platformExecutableRegistryHistory().map(
      composeExecutableCompatibilityRelease,
    ),
  );
  const releaseSupport = createExecutableCompatibilityReleaseSupport(
    platformRegistryReleaseSupport().map(composeExecutableCompatibilityRelease),
  );
  return createOperatorRunReplayStore(
    database,
    releaseSupport.descriptions,
    (projection, currentCompatibilityRelease) => {
      try {
        return createInitialCheckpoint(
          { ...projection, currentCompatibilityRelease },
          { releaseSupport: releaseHistory },
        );
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
