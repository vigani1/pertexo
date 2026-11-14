import { utf8ByteLength } from '@pertexo/workflow-model';

import { z } from 'zod';

export const DATA_KEY_BYTES = 32;

export const GCM_NONCE_BYTES = 12;

export const GCM_TAG_BYTES = 16;

export const MAX_ENCRYPTED_DATA_KEY_BYTES = 8_192;

const MAX_KEY_REFERENCE_BYTES = 2_048;

export const encodedEnvelopeSchemaFields = Object.freeze({
  kmsKeyReference: z.string().min(1).max(MAX_KEY_REFERENCE_BYTES),
  encryptedDataKey: z.string().min(1),
  ciphertext: z.string().min(1),
  nonce: z.string().min(1),
});

export type EncodedEnvelope = Readonly<{
  keyReference: string;
  encryptedDataKey: string;
  ciphertext: string;
  nonce: string;
  authTag: string;
}>;

export type FailureFactory = () => Error;

export function fail(createFailure: FailureFactory): never {
  throw createFailure();
}

export function assertNotAborted(
  signal: AbortSignal | undefined,
  createFailure: FailureFactory,
): void {
  if (signal?.aborted) fail(createFailure);
}

export function boundedBytes(
  value: unknown,
  minimum: number,
  maximum: number,
  createFailure: FailureFactory,
): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < minimum ||
    value.byteLength > maximum
  )
    fail(createFailure);
  return new Uint8Array(value);
}

export function isValidEnvelopeKeyReference(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    utf8ByteLength(value) <= MAX_KEY_REFERENCE_BYTES
  );
}

export function validKeyReference(
  value: unknown,
  createFailure: FailureFactory,
): string {
  if (!isValidEnvelopeKeyReference(value)) fail(createFailure);
  return value;
}

export function responseRecord(
  value: unknown,
  createFailure: FailureFactory,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object') fail(createFailure);
  return value as Readonly<Record<string, unknown>>;
}

export function encode(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

export function decode(
  value: string,
  minimum: number,
  maximum: number,
  createFailure: FailureFactory,
): Uint8Array {
  const maximumEncodedLength = Math.ceil((maximum * 4) / 3);
  if (value.length > maximumEncodedLength || !/^[A-Za-z0-9_-]*$/u.test(value))
    fail(createFailure);
  const decoded = Buffer.from(value, 'base64url');
  try {
    if (
      decoded.byteLength < minimum ||
      decoded.byteLength > maximum ||
      decoded.toString('base64url') !== value
    )
      fail(createFailure);
    return new Uint8Array(decoded);
  } finally {
    decoded.fill(0);
  }
}
