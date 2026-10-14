import type { NodeArtifactRuntime } from '@pertexo/node-sdk/server';
import {
  HTTP_REQUEST_LIMITS,
  type HttpRequestInput,
  type HttpRequestConfig,
} from './validation.js';
import { requestBody } from './request-material.js';

export async function readRequestBody(
  input: HttpRequestInput,
  method: HttpRequestConfig['method'],
  artifacts: NodeArtifactRuntime | undefined,
  signal: AbortSignal,
  failure: () => Error,
): Promise<Uint8Array | undefined> {
  const body = input.body;
  if (body === undefined || !('kind' in body))
    return requestBody(input, method, failure);
  if (method === 'GET' || method === 'HEAD' || artifacts?.read === undefined)
    throw failure();
  const { kind: _kind, ...reference } = body;
  return artifacts.read({
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
