import { FailureNotificationStateError, type FailureNotificationStore } from '@pertexo/core/notifications';

import {
  assertNever,
  type FailureNotificationDeliveryResult,
} from '@pertexo/workflow-model';
import type { FailureNotificationDeliveryCapability } from './failure-handler.js';
import { settleUnresolvedDelivery, canceled } from './delivery/outcomes.js';
import {
  type DeliveryInput,
  type DeliveryDependencies,
  deliverSlack,
  deliverEmail,
} from './delivery/transport.js';

export function createProviderFailureNotificationDelivery(
  dependencies: DeliveryDependencies,
): FailureNotificationDeliveryCapability {
  return Object.freeze({
    deliver: async (
      input: DeliveryInput,
    ): Promise<FailureNotificationDeliveryResult> => {
      let destination: Awaited<
        ReturnType<FailureNotificationStore['loadDestination']>
      >;
      try {
        destination = await dependencies.store.loadDestination({
          workspaceId: input.workspaceId,
          intentId: input.intentId,
          attemptNumber: input.attemptNumber,
          workerId: dependencies.workerId,
          signal: input.signal,
        });
      } catch (error: unknown) {
        if (input.signal.aborted) return canceled(input);
        if (error instanceof FailureNotificationStateError)
          return input.deliveryUnresolved
            ? {
                kind: 'outcome_unknown',
                safeErrorCode: 'delivery.identity_changed',
                possiblyDispatched: true,
              }
            : {
                kind: 'definite_failure',
                safeErrorCode: 'delivery.destination_unavailable',
                possiblyDispatched: false,
              };
        return settleUnresolvedDelivery(
          {
            kind: 'retry',
            safeErrorCode: 'delivery.destination_unavailable',
            possiblyDispatched: false,
          },
          { deliveryUnresolved: input.deliveryUnresolved },
        );
      }
      // A retry of a send that may have gone out must use the same credential.
      if (
        input.deliveryUnresolved &&
        destination.secretVersionId !== input.connectionSecretVersionId
      )
        return settleUnresolvedDelivery(
          {
            kind: 'definite_failure',
            safeErrorCode: 'delivery.identity_changed',
            possiblyDispatched: false,
          },
          { deliveryUnresolved: input.deliveryUnresolved },
        );
      switch (destination.kind) {
        case 'slack':
          return deliverSlack(dependencies, destination, input);
        case 'email':
          return deliverEmail(dependencies, destination, input);
        default:
          return assertNever(destination);
      }
    },
  });
}
