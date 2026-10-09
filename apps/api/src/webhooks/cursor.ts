import { z } from 'zod';

import {
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from '../platform/http/opaque-cursor.js';

const deliveryCursorPayloadSchema = z
  .object({
    kind: z.literal('webhook_deliveries'),
    triggerId: z.uuid(),
    receivedAt: z.iso.datetime({ precision: 6 }),
    id: z.uuid(),
  })
  .strict()
  .readonly();

type WebhookDeliveryPosition = Readonly<{ receivedAt: string; id: string }>;

export class InvalidWebhookDeliveryCursorError extends TypeError {
  public override readonly name = 'InvalidWebhookDeliveryCursorError';

  public constructor() {
    super('webhook delivery cursor is invalid');
  }
}

/** An opaque delivery-log position that only continues the same trigger. */
export function encodeWebhookDeliveryCursor(
  triggerId: string,
  position: WebhookDeliveryPosition,
): string {
  return encodeOpaqueCursor(deliveryCursorPayloadSchema, {
    kind: 'webhook_deliveries',
    triggerId,
    receivedAt: position.receivedAt,
    id: position.id,
  });
}

export function decodeWebhookDeliveryCursor(
  value: string,
  triggerId: string,
): WebhookDeliveryPosition {
  const payload = decodeOpaqueCursor(deliveryCursorPayloadSchema, value);
  if (payload?.triggerId !== triggerId)
    throw new InvalidWebhookDeliveryCursorError();
  return Object.freeze({ receivedAt: payload.receivedAt, id: payload.id });
}
