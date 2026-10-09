import { applyConnectionHealthObservation } from '@pertexo/database/connections';
import {
  canonicalOutboxPayloadChecksum,
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
} from '@pertexo/database/outbox';
import {
  createWorkspaceDatabase,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  unrecoverableQueueError,
  type QueueDelivery,
  type QueueHandlerContext,
} from '@pertexo/queue';

import type { ConnectionRunHealthMode } from '../config/connection-health.js';

type HealthDelivery = Extract<
  QueueDelivery,
  { readonly name: 'apply-connection-health-observation' }
>;

export interface ConnectionHealthObservationStore {
  apply(
    input: Parameters<typeof applyConnectionHealthObservation>[1],
  ): ReturnType<typeof applyConnectionHealthObservation>;
  checkReadiness?(): Promise<void>;
  close?(): Promise<void>;
}

function createDatabaseConnectionHealthObservationStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): ConnectionHealthObservationStore {
  const database = createWorkspaceDatabase(
    config,
    runtime === undefined ? {} : { runtime },
  );
  return Object.freeze({
    apply: (input: Parameters<typeof applyConnectionHealthObservation>[1]) =>
      applyConnectionHealthObservation(database, input),
    checkReadiness: async (): Promise<void> => {
      await database.checkReadiness();
    },
    close: () => database.close(),
  });
}

export function createConnectionHealthObservationHandler(
  store: ConnectionHealthObservationStore,
  mode: ConnectionRunHealthMode,
) {
  return Object.freeze({
    handle: async (delivery: HealthDelivery, context: QueueHandlerContext) => {
      try {
        return await store.apply({
          workspaceId: delivery.data.workspaceId,
          observationId: delivery.data.observationId,
          delivery: {
            outboxEventId: delivery.data.outboxEventId,
            payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
          },
          mode,
          signal: context.signal,
        });
      } catch (error: unknown) {
        if (
          error instanceof InboxChecksumMismatchError ||
          error instanceof InboxReceiptUnavailableError
        )
          throw unrecoverableQueueError(
            'Connection health failed durable state verification',
          );
        throw error;
      }
    },
  });
}

export const connectionHealthObservationFactories = Object.freeze({
  store: createDatabaseConnectionHealthObservationStore,
  handler: createConnectionHealthObservationHandler,
});
