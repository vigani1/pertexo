import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhookSignature(
  input: Readonly<{
    secret: Uint8Array;
    timestamp: string;
    signature: string;
    rawBody: Uint8Array;
  }>,
): boolean {
  if (
    !/^v1=[0-9a-f]{64}$/u.test(input.signature) ||
    !/^\d{1,16}$/u.test(input.timestamp)
  )
    return false;
  const expected = createHmac('sha256', input.secret)
    .update(input.timestamp, 'ascii')
    .update('.')
    .update(input.rawBody)
    .digest();
  const supplied = Buffer.from(input.signature.slice(3), 'hex');
  return (
    expected.byteLength === supplied.byteLength &&
    timingSafeEqual(expected, supplied)
  );
}
