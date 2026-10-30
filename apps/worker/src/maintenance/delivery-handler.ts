import type { ErrorWorkflowHandler } from '../notifications/error-workflow.js';
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
} from '../attempts/delivery/unknown-outcome-reconciliation.js';
import type { createOperatorRunReplayHandler } from '../operator/run-replay.js';
import type { FailureNotificationHandler } from '../notifications/failure-handler.js';
import type { WorkspaceInvitationDeliveryHandler } from '../identity/invitation-delivery.js';
import type { createConnectionHealthObservationHandler } from '../connections/health-runtime.js';

export type MaintenanceHandlers = Readonly<{
  failureNotification?: FailureNotificationHandler;
  errorWorkflow?: ErrorWorkflowHandler;
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
      case JOB_NAME.startErrorWorkflow:
        assertMaintenanceHandlerEnabled(
          handlers.errorWorkflow,
          'Error workflow delivery is not enabled',
        );
        await handlers.errorWorkflow.handle(delivery, context);
        return;
      case JOB_NAME.applyConnectionHealthObservation:
        assertMaintenanceHandlerEnabled(
          handlers.connectionHealth,
          'Connection health application is not enabled',
        );
        await handlers.connectionHealth.handle(delivery, context);
        return;
      case JOB_NAME.reconcilePreviewAttempt:
        assertMaintenanceHandlerEnabled(
          handlers.reconciliation,
          'Preview reconciliation is not enabled',
        );
        try {
          await handlers.reconciliation.handle(delivery, context);
        } catch (error: unknown) {
          throw mapPreviewReconciliationError(error);
        }
        return;
      case JOB_NAME.reconcileUnknownOutcome:
        assertMaintenanceHandlerEnabled(
          handlers.unknownOutcome,
          'Unknown-outcome reconciliation is not enabled',
        );
        try {
          await handlers.unknownOutcome.handle(delivery, context);
        } catch (error: unknown) {
          throw mapUnknownOutcomeReconciliationError(error);
        }
        return;
      case JOB_NAME.replayWorkflowRun:
        assertMaintenanceHandlerEnabled(
          handlers.replay,
          'Run replay is not enabled',
        );
        await handlers.replay.handle(delivery, context);
        return;
      case JOB_NAME.deliverRunFailureNotification:
        assertMaintenanceHandlerEnabled(
          handlers.failureNotification,
          'Failure notification delivery is not enabled',
        );
        await handlers.failureNotification.handle(delivery, context);
        return;
      case JOB_NAME.deliverWorkspaceInvitation:
        assertMaintenanceHandlerEnabled(
          handlers.workspaceInvitation,
          'Workspace invitation delivery is not enabled',
        );
        await handlers.workspaceInvitation.handle(delivery, context);
        return;
      case JOB_NAME.advanceWorkflowRun:
      case JOB_NAME.executeNodeAttempt:
      case JOB_NAME.executePreviewAttempt:
      case JOB_NAME.reconcileWorkflowTriggers:
        throw new InvalidQueueDeliveryError(
          `Maintenance cannot handle ${delivery.name}`,
        );
      default:
        // A new job fails the build here rather than every delivery at runtime.
        delivery satisfies never;
        throw new InvalidQueueDeliveryError(
          'Maintenance cannot handle an unknown job',
        );
    }
  };
}

function assertMaintenanceHandlerEnabled<Handler>(
  handler: Handler | undefined,
  message: string,
): asserts handler is Handler {
  if (handler === undefined) throw new InvalidQueueDeliveryError(message);
}
