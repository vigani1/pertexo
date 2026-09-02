import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface CryptographicRandomSource {
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

/** Generates a canonical RFC 4122 version 4 UUID without making the domain depend on UUID SDKs. */
export function randomUuid(crypto: CryptographicRandomSource): string {
  const bytes = Buffer.from(crypto.randomBytes(16));
  if (bytes.byteLength !== 16) {
    throw new RangeError('UUID randomness must contain exactly 16 bytes');
  }
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x40, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
