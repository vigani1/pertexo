import { createHmac } from 'node:crypto';
import { it, expect } from 'vitest';
import { verifyWebhookSignature } from '../../src/webhooks/verify-signature.js';

it('verifies lowercase v1 HMAC over timestamp dot exact raw bytes', () => {
  const secret = new Uint8Array(32).fill(3);
  const rawBody = new TextEncoder().encode('{"value": 1}\n');
  const timestamp = '1787659200';
  const signature = `v1=${createHmac('sha256', secret)
    .update(timestamp, 'ascii')
    .update('.')
    .update(rawBody)
    .digest('hex')}`;

  expect(
    verifyWebhookSignature({ secret, timestamp, signature, rawBody }),
  ).toBe(true);
  expect(
    verifyWebhookSignature({
      secret,
      timestamp,
      signature: signature.toUpperCase(),
      rawBody,
    }),
  ).toBe(false);
  expect(
    verifyWebhookSignature({
      secret,
      timestamp,
      signature,
      rawBody: new TextEncoder().encode('{"value":1}\n'),
    }),
  ).toBe(false);
});
