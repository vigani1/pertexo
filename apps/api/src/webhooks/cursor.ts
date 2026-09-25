import { z } from 'zod';

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
  return Buffer.from(
    JSON.stringify(
      deliveryCursorPayloadSchema.parse({
        kind: 'webhook_deliveries',
        triggerId,
        receivedAt: position.receivedAt,
        id: position.id,
      }),
    ),
    'utf8',
  ).toString('base64url');
}

export function decodeWebhookDeliveryCursor(
  value: string,
  triggerId: string,
): WebhookDeliveryPosition {
  let payload: z.output<typeof deliveryCursorPayloadSchema>;
  try {
    payload = deliveryCursorPayloadSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
  } catch {
    throw new InvalidWebhookDeliveryCursorError();
  }
  if (payload.triggerId !== triggerId)
    throw new InvalidWebhookDeliveryCursorError();
  return Object.freeze({ receivedAt: payload.receivedAt, id: payload.id });
}
