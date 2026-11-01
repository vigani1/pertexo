import {
  NodeAttemptDeliveryMismatchError,
  NodeAttemptStateCorruptError,
} from '@pertexo/core/attempts';
import type { RunFailureStore } from '@pertexo/core/runs';

import {
  InvalidQueueDeliveryError,
  JOB_NAME,
  type QueueJobHandler,
  unrecoverableQueueError,
} from '@pertexo/queue';

import {
  type NodeAttemptHandler,
  NodeAttemptHandlerStateError,
} from '../handler.js';

import {
  mapPreviewHandlerError,
  type PreviewAttemptHandler,
} from '../../../previews/runtime.js';

/** Shown on the run: its stored state can never produce this attempt. */
const UNADVANCEABLE_RUN_CODE = 'execution.run_state_invalid';
/** A few tries first, so a state that only looked wrong can't end a healthy run. */
const UNADVANCEABLE_AFTER_DELIVERIES = 4;

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
          error instanceof NodeAttemptHandlerStateError);
      if (
        stateRefused &&
        delivery.transport.attemptsMade + 1 < UNADVANCEABLE_AFTER_DELIVERIES
      )
        throw error;
      if (stateRefused)
        await runFailures.failUnadvanceable({
          workspaceId: delivery.data.workspaceId,
          runId: delivery.data.runId,
          safeErrorCode: UNADVANCEABLE_RUN_CODE,
          signal: context.signal,
        });
      if (
        error instanceof NodeAttemptDeliveryMismatchError ||
        error instanceof NodeAttemptStateCorruptError ||
        error instanceof NodeAttemptHandlerStateError
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
