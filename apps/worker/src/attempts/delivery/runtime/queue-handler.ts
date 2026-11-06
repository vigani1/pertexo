import {
  NodeAttemptDeliveryMismatchError,
  NodeAttemptStateCorruptError,
} from '@pertexo/core/attempts';
import { isStoredDataError } from '@pertexo/core/shared';
import type { RunFailureStore } from '@pertexo/core/runs';

import {
  InvalidQueueDeliveryError,
  JOB_NAME,
  type QueueJobHandler,
  unrecoverableQueueError,
} from '@pertexo/queue/server';

import {
  type NodeAttemptHandler,
  NodeAttemptHandlerStateError,
} from '../handle-node-attempt-delivery.js';

import {
  mapPreviewHandlerError,
  type PreviewAttemptHandler,
} from '../../../previews/preview-invoker.runtime.js';

/** Shown on the run: its stored state can never produce this attempt. */
const UNADVANCEABLE_RUN_CODE = 'execution.run_state_invalid';

export function queueHandler(
  handler: NodeAttemptHandler,
  previewHandler: PreviewAttemptHandler | undefined,
  runFailures: RunFailureStore,
): QueueJobHandler {
  return async (delivery, context): Promise<void> => {
    if (
      delivery.name !== JOB_NAME.executeNodeAttempt &&
      delivery.name !== JOB_NAME.executePreviewAttempt
    )
      throw new InvalidQueueDeliveryError(
        `Node-attempt consumer cannot handle ${delivery.name}`,
      );
    try {
      if (
        previewHandler !== undefined &&
        delivery.name === JOB_NAME.executePreviewAttempt
      ) {
        await previewHandler.handle(delivery, context);
        return;
      }
      if (delivery.name !== JOB_NAME.executeNodeAttempt)
        throw new InvalidQueueDeliveryError(
          `Node-attempt consumer cannot handle ${delivery.name}`,
        );
      await handler.handle(delivery, context);
    } catch (error: unknown) {
      const stateRefused =
        delivery.name === JOB_NAME.executeNodeAttempt &&
        (error instanceof NodeAttemptStateCorruptError ||
          error instanceof NodeAttemptHandlerStateError ||
          isStoredDataError(error));
      if (stateRefused)
        await runFailures.failUnadvanceable({
          workspaceId: delivery.data.workspaceId,
          runId: delivery.data.runId,
          safeErrorCode: UNADVANCEABLE_RUN_CODE,
          ...emergencyAttemptAuthority(error),
          signal: context.signal,
        });
      if (
        error instanceof NodeAttemptDeliveryMismatchError ||
        error instanceof NodeAttemptStateCorruptError ||
        stateRefused
      )
        throw unrecoverableQueueError(
          error instanceof NodeAttemptHandlerStateError
            ? `Node-attempt delivery is not recoverable: ${error.code}`
            : 'Node-attempt delivery failed durable state verification',
        );
      throw mapPreviewHandlerError(error);
    }
  };
}

/** A failed setup owns a lease or a still-corrupt unclaimed fence. */
function emergencyAttemptAuthority(error: unknown) {
  if (error instanceof NodeAttemptHandlerStateError)
    return {
      expectedRevision: error.lease?.checkpointRevision,
      ...(error.lease === undefined ? {} : { attemptLease: error.lease }),
    };
  if (
    error instanceof NodeAttemptStateCorruptError &&
    error.claimRefusal !== undefined
  )
    return {
      expectedRevision: error.claimRefusal.checkpointRevision,
      claimRefusal: error.claimRefusal,
    };
  return { expectedRevision: undefined };
}
