import type {
  NodeArtifactRuntime,
  NodeVerifiedByteSource,
} from '@pertexo/node-sdk/server';
import {
  HTTP_REQUEST_LIMITS,
  type HttpRequestInput,
  type HttpRequestConfig,
} from './validation.js';
import { requestBody } from './material.js';

export async function readRequestBody(
  input: HttpRequestInput,
  method: HttpRequestConfig['method'],
  {
    artifacts,
    signal,
    failure,
  }: Readonly<{
    artifacts: NodeArtifactRuntime | undefined;
    signal: AbortSignal;
    failure: () => Error;
  }>,
): Promise<Uint8Array | NodeVerifiedByteSource | undefined> {
  const body = input.body;
  if (body === undefined || !('kind' in body))
    return requestBody(input, method, failure);
  if (
    method === 'GET' ||
    method === 'HEAD' ||
    artifacts?.openVerified === undefined
  )
    throw failure();
  const { kind: _kind, ...reference } = body;
  return artifacts.openVerified({
    reference,
    maxBytes: HTTP_REQUEST_LIMITS.maxRequestBodyBytes,
    signal,
  });
}

export function artifactContentType(
  input: HttpRequestInput,
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (
    input.body === undefined ||
    !('kind' in input.body) ||
    Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')
  )
    return headers;
  return { ...headers, 'content-type': input.body.mediaType };
}
