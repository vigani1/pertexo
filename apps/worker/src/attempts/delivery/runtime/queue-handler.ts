import {
  NodeAttemptDeliveryMismatchError,
  NodeAttemptStateCorruptError,
} from '@pertexo/database/attempts';

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

export function queueHandler(
  handler: NodeAttemptHandler,
  previewHandler: PreviewAttemptHandler | undefined,
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
