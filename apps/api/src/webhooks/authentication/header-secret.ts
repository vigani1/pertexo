import { timingSafeEqual } from 'node:crypto';

export function verifyWebhookHeaderSecret(
  secret: Uint8Array,
  supplied: string,
): boolean {
  const expected = Buffer.from(Buffer.from(secret).toString('base64url'));
  const candidate = Buffer.from(supplied);
  // Length is part of the public credential format, not secret material.
  return (
    expected.byteLength === candidate.byteLength &&
    timingSafeEqual(expected, candidate)
  );
}
