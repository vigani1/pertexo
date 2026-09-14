import { Buffer } from 'node:buffer';

import type { z } from 'zod';

import {
  HTTP_REQUEST_LIMITS,
  resolvedHttpHeadersCredentialSchema,
  type HttpRequestConfig,
  type HttpRequestInput,
} from './validation.js';

type FailureFactory = () => Error;
type HttpCredential = z.output<typeof resolvedHttpHeadersCredentialSchema>;

export function requestBody(
  input: HttpRequestInput,
  method: HttpRequestConfig['method'],
  createFailure: FailureFactory,
): Uint8Array | undefined {
  if (input.body === undefined) return undefined;
  if (method === 'GET' || method === 'HEAD') throw createFailure();
  if (input.body.encoding === 'utf8') {
    const bytes = new TextEncoder().encode(input.body.value);
    if (bytes.byteLength > HTTP_REQUEST_LIMITS.maxRequestBodyBytes)
      throw createFailure();
    return bytes;
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      input.body.value,
    )
  )
    throw createFailure();
  const bytes = Buffer.from(input.body.value, 'base64');
  if (
    bytes.byteLength > HTTP_REQUEST_LIMITS.maxRequestBodyBytes ||
    bytes.toString('base64') !== input.body.value
  )
    throw createFailure();
  return new Uint8Array(bytes);
}

export function decodeCredential(
  secret: Uint8Array,
  createFailure: FailureFactory,
): HttpCredential {
  try {
    return resolvedHttpHeadersCredentialSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(secret)),
    );
  } catch {
    throw createFailure();
  }
}

export function mergeHeaders(
  configured: Readonly<Record<string, string>>,
  credential: Readonly<Record<string, string>>,
  createFailure: FailureFactory,
): Readonly<Record<string, string>> {
  const normalizedConfigured = Object.fromEntries(
    Object.entries(configured).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  if (
    Object.keys(credential).some((name) =>
      Object.hasOwn(normalizedConfigured, name),
    )
  )
    throw createFailure();
  return Object.freeze({ ...normalizedConfigured, ...credential });
}
