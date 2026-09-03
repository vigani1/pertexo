import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

interface CryptographicRandomSource {
  randomBytes(length: number): Uint8Array;
}

export interface CryptographicHasher {
  sha256(value: string): Uint8Array;
}

export interface IdentityCrypto
  extends CryptographicRandomSource, CryptographicHasher {
  timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean;
}

export const nodeIdentityCrypto: IdentityCrypto = Object.freeze({
  randomBytes: (length: number) => randomBytes(length),
  sha256: (value: string) =>
    createHash('sha256').update(value, 'utf8').digest(),
  timingSafeEqual: (left: Uint8Array, right: Uint8Array) => {
    if (left.byteLength !== right.byteLength) return false;
    return timingSafeEqual(left, right);
  },
});

export function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

export function digestBase64Url(
  value: string,
  crypto: CryptographicHasher,
): string {
  return encodeBase64Url(crypto.sha256(value));
}

/** Hex is used for persisted digests so the database representation is fixed at 64 chars. */
export function digestSha256Hex(
  value: string,
  crypto: CryptographicHasher,
): string {
  return Buffer.from(crypto.sha256(value)).toString('hex');
}

export function constantTimeStringEqual(
  left: string,
  right: string,
  crypto: IdentityCrypto = nodeIdentityCrypto,
): boolean {
  return crypto.timingSafeEqual(
    Buffer.from(left, 'utf8'),
    Buffer.from(right, 'utf8'),
  );
}
