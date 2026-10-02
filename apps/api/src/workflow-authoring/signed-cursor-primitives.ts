import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidWorkflowCursorError } from './cursor.js';

export const SIGNED_CURSOR_MAX_UNIX_SECONDS = 253_402_300_799;
const MAX_WIRE_BYTES = 512;

export function currentSignedCursorSeconds(now: () => number): number {
  const millis = now();
  if (
    !Number.isSafeInteger(millis) ||
    millis < 0 ||
    millis > SIGNED_CURSOR_MAX_UNIX_SECONDS * 1000 + 999
  )
    throw new InvalidWorkflowCursorError();
  return Math.floor(millis / 1000);
}

export function assertSignedCursorLifetime(
  issued: number,
  expires: number,
  current: number,
  ttl: number,
): void {
  if (issued > current || expires <= current || expires - issued !== ttl)
    throw new InvalidWorkflowCursorError();
}

function canonicalBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+(?![\s\S])/u.test(value))
    throw new InvalidWorkflowCursorError();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value)
    throw new InvalidWorkflowCursorError();
  return bytes;
}

export type SignedCursorByteEnvelope = Readonly<{
  encode(bytes: Uint8Array): string;
  authenticate(wire: string): Buffer;
}>;

/** Only authenticates bounded bytes; semantic schemas and canonical JSON remain with each codec. */
export function createSignedCursorByteEnvelope(
  key: Uint8Array,
  invalidKeyMessage: string,
  subkeyLabel?: string,
): SignedCursorByteEnvelope {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32)
    throw new TypeError(invalidKeyMessage);
  const root = Buffer.from(key);
  let signingKey = root;
  if (subkeyLabel !== undefined) {
    try {
      signingKey = createHmac('sha256', root)
        .update(subkeyLabel, 'utf8')
        .digest();
    } finally {
      root.fill(0);
    }
  }
  const mac = (bytes: Uint8Array): Buffer =>
    createHmac('sha256', signingKey).update(bytes).digest();
  return Object.freeze({
    encode(bytes): string {
      const wire = `${Buffer.from(bytes).toString('base64url')}.${mac(bytes).toString('base64url')}`;
      if (wire.length > MAX_WIRE_BYTES) throw new InvalidWorkflowCursorError();
      return wire;
    },
    authenticate(wire): Buffer {
      if (
        typeof wire !== 'string' ||
        wire.length > MAX_WIRE_BYTES ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![\s\S])/u.test(wire)
      )
        throw new InvalidWorkflowCursorError();
      const [payload, signature] = wire.split('.');
      if (payload === undefined || signature === undefined)
        throw new InvalidWorkflowCursorError();
      const bytes = canonicalBase64Url(payload);
      const supplied = canonicalBase64Url(signature);
      if (supplied.byteLength !== 32 || !timingSafeEqual(mac(bytes), supplied))
        throw new InvalidWorkflowCursorError();
      return bytes;
    },
  });
}
