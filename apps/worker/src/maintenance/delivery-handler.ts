import {
  InvalidQueueDeliveryError,
  JOB_NAME,
  type QueueConsumerOptions,
} from '@pertexo/queue';
import {
  mapPreviewReconciliationError,
  type createPreviewReconciliationHandler,
} from '../previews/reconciliation.js';
import {
  mapUnknownOutcomeReconciliationError,
  type createUnknownOutcomeReconciliationHandler,
} from '../attempts/unknown-outcome-reconciliation.js';
import type { createOperatorRunReplayHandler } from '../operator/run-replay.js';
import type { FailureNotificationHandler } from '../notifications/failure-handler.js';
import type { WorkspaceInvitationDeliveryHandler } from '../identity/invitation-delivery.js';
import type { createConnectionHealthObservationHandler } from '../connections/health-runtime.js';

export type MaintenanceHandlers = Readonly<{
  failureNotification?: FailureNotificationHandler;
  reconciliation?: ReturnType<typeof createPreviewReconciliationHandler>;
  replay?: ReturnType<typeof createOperatorRunReplayHandler>;
  unknownOutcome?: ReturnType<typeof createUnknownOutcomeReconciliationHandler>;
  workspaceInvitation?: WorkspaceInvitationDeliveryHandler;
  connectionHealth?: ReturnType<
    typeof createConnectionHealthObservationHandler
  >;
}>;

export function maintenanceDeliveryHandler(
  handlers: MaintenanceHandlers,
): QueueConsumerOptions['handler'] {
  return async (delivery, context): Promise<void> => {
    switch (delivery.name) {
      case JOB_NAME.applyConnectionHealthObservation:
        if (handlers.connectionHealth === undefined)
          throw new InvalidQueueDeliveryError(
            'Connection health application is not enabled',
          );
        await handlers.connectionHealth.handle(delivery, context);
        return;
      case JOB_NAME.reconcilePreviewAttempt:
        if (handlers.reconciliation === undefined)
          throw new InvalidQueueDeliveryError(
            'Preview reconciliation is not enabled',
          );
        try {
          await handlers.reconciliation.handle(delivery, context);
        } catch (error: unknown) {
          throw mapPreviewReconciliationError(error);
        }
        return;
      case JOB_NAME.reconcileUnknownOutcome:
        if (handlers.unknownOutcome === undefined)
          throw new InvalidQueueDeliveryError(
            'Unknown-outcome reconciliation is not enabled',
          );
        try {
          await handlers.unknownOutcome.handle(delivery, context);
        } catch (error: unknown) {
          throw mapUnknownOutcomeReconciliationError(error);
        }
        return;
      case JOB_NAME.replayWorkflowRun:
        if (handlers.replay === undefined)
          throw new InvalidQueueDeliveryError('Run replay is not enabled');
        await handlers.replay.handle(delivery, context);
        return;
      case JOB_NAME.deliverRunFailureNotification:
        if (handlers.failureNotification === undefined)
          throw new InvalidQueueDeliveryError(
            'Failure notification delivery is not enabled',
          );
        await handlers.failureNotification.handle(delivery, context);
        return;
      case JOB_NAME.deliverWorkspaceInvitation:
        if (handlers.workspaceInvitation === undefined)
          throw new InvalidQueueDeliveryError(
            'Workspace invitation delivery is not enabled',
          );
        await handlers.workspaceInvitation.handle(delivery, context);
        return;
      default:
        throw new InvalidQueueDeliveryError(
          `Maintenance cannot handle ${delivery.name}`,
        );
    }
  };
}
