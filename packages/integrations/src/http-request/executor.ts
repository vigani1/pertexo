import { Buffer } from 'node:buffer';

import {
  DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  type NodeExecutionInvocation,
  type NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { z } from 'zod';

import {
  classifySecureHttpError,
  classifySecureHttpResponse,
  HTTP_SIDE_EFFECT_CLASS,
  type HttpOutcomeDecision,
} from '../http/outcome-policy.js';
import { SecureHttpError, type SecureHttpClient } from '../http/secure-http.js';
import {
  HTTP_REQUEST_CONNECTION_SLOT,
  HTTP_REQUEST_DEFINITION,
  HTTP_REQUEST_EXECUTOR,
  HTTP_REQUEST_NETWORK_POLICY,
  HTTP_REQUEST_VALUE_POLICY,
} from './definition.js';
import {
  HTTP_REQUEST_LIMITS,
  httpRequestConfigSchema,
  httpRequestInputSchema,
  httpRequestOutputSchema,
  type HttpRequestOutput,
} from './validation.js';

const credentialHeaderNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u);
const blockedCredentialHeaders = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'idempotency-key',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const resolvedCredentialSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal('http_headers'),
    headers: z
      .record(
        credentialHeaderNameSchema,
        z
          .string()
          .min(1)
          .max(8_192)
          .refine((value) => !/[\r\n\0]/u.test(value)),
      )
      .superRefine((headers, context) => {
        const entries = Object.entries(headers);
        if (entries.length < 1 || entries.length > 32)
          context.addIssue({
            code: 'custom',
            message: 'credential header count is invalid',
          });
        const normalized = new Set<string>();
        let bytes = 0;
        for (const [name, value] of entries) {
          const canonicalName = name.toLowerCase();
          bytes += new TextEncoder().encode(
            `${canonicalName}:${value}\r\n`,
          ).byteLength;
          if (
            normalized.has(canonicalName) ||
            blockedCredentialHeaders.has(canonicalName)
          )
            context.addIssue({
              code: 'custom',
              path: [name],
              message: 'credential header is invalid',
            });
          normalized.add(canonicalName);
        }
        if (bytes > 16_384)
          context.addIssue({
            code: 'custom',
            message: 'credential headers exceed byte limit',
          });
      })
      .transform((headers) =>
        Object.freeze(
          Object.fromEntries(
            Object.entries(headers).map(([name, value]) => [
              name.toLowerCase(),
              value,
            ]),
          ),
        ),
      ),
  })
  .strict();

export class HttpRequestExecutorError extends Error {
  public override readonly name = 'HttpRequestExecutorError';

  public constructor(
    public readonly decision: HttpOutcomeDecision,
    public readonly possiblyDispatched: boolean,
  ) {
    super(`HTTP Request execution failed: ${decision.kind}`);
  }
}

export type HttpRequestExecutorDependencies = Readonly<{
  httpClient: Pick<SecureHttpClient, 'executeStreaming'>;
}>;

function failedConfiguration(): HttpRequestExecutorError {
  return new HttpRequestExecutorError(
    Object.freeze({ kind: 'failed', errorKind: 'configuration' }),
    false,
  );
}

function requestBody(
  input: z.output<typeof httpRequestInputSchema>,
  method: z.output<typeof httpRequestConfigSchema>['method'],
): Uint8Array | undefined {
  if (input.body === undefined) return undefined;
  if (method === 'GET' || method === 'HEAD') throw failedConfiguration();
  if (input.body.encoding === 'utf8') {
    const bytes = new TextEncoder().encode(input.body.value);
    if (bytes.byteLength > HTTP_REQUEST_LIMITS.maxRequestBodyBytes)
      throw failedConfiguration();
    return bytes;
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      input.body.value,
    )
  )
    throw failedConfiguration();
  const bytes = Buffer.from(input.body.value, 'base64');
  if (
    bytes.byteLength > HTTP_REQUEST_LIMITS.maxRequestBodyBytes ||
    bytes.toString('base64') !== input.body.value
  )
    throw failedConfiguration();
  return new Uint8Array(bytes);
}

function decodeCredential(secret: Uint8Array) {
  try {
    return resolvedCredentialSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(secret)),
    );
  } catch {
    throw new HttpRequestExecutorError(
      Object.freeze({ kind: 'failed', errorKind: 'authentication' }),
      false,
    );
  }
}

function mergeHeaders(
  configured: Readonly<Record<string, string>>,
  credential: Readonly<Record<string, string>>,
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
    throw failedConfiguration();
  return Object.freeze({ ...normalizedConfigured, ...credential });
}

function inlineBody(bytes: Uint8Array, preferred: 'base64' | 'utf8') {
  if (preferred === 'utf8') {
    try {
      return Object.freeze({
        kind: 'inline' as const,
        encoding: 'utf8' as const,
        value: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        byteLength: bytes.byteLength,
      });
    } catch {
      // Invalid text is represented exactly as base64.
    }
  }
  return Object.freeze({
    kind: 'inline' as const,
    encoding: 'base64' as const,
    value: Buffer.from(bytes).toString('base64'),
    byteLength: bytes.byteLength,
  });
}

async function executeHttpRequest(
  dependencies: HttpRequestExecutorDependencies,
  invocation: NodeExecutionInvocation<unknown, unknown>,
): Promise<HttpRequestOutput> {
  const config = httpRequestConfigSchema.parse(invocation.config);
  const input = httpRequestInputSchema.parse(invocation.input);
  const runtime = invocation.runtime;
  if (runtime === undefined) throw failedConfiguration();
  const connections = runtime.connections;
  if (
    connections?.assertCurrent === undefined ||
    runtime.sideEffectClass !== 'unsafe' ||
    runtime.providerIdempotencyKey !== undefined ||
    Object.keys(invocation.connectionRefs).length !== 1
  )
    throw failedConfiguration();
  const assertCurrent = connections.assertCurrent;
  const connectionId = invocation.connectionRefs[HTTP_REQUEST_CONNECTION_SLOT];
  if (connectionId === undefined) throw failedConfiguration();
  const target = new URL(config.url);
  if (target.protocol !== 'https:') throw failedConfiguration();

  let resolved;
  try {
    resolved = await connections.resolve({
      connectionId,
      expectedProviderKey: 'http',
      expectedAuthType: 'http_headers',
      purpose: 'http.request.execute',
      signal: invocation.signal,
    });
  } catch {
    throw new HttpRequestExecutorError(
      Object.freeze({ kind: 'failed', errorKind: 'authentication' }),
      false,
    );
  }
  let body: Uint8Array | undefined;
  try {
    if (
      resolved.connectionId !== connectionId ||
      resolved.providerKey !== 'http' ||
      resolved.authType !== 'http_headers'
    )
      throw failedConfiguration();
    const credential = decodeCredential(resolved.secret);
    body = requestBody(input, config.method);
    let response;
    try {
      response = await dependencies.httpClient.executeStreaming(
        {
          url: config.url,
          method: config.method,
          headers: mergeHeaders(config.headers, credential.headers),
          ...(body === undefined ? {} : { body }),
          timeoutMillis: config.timeoutMillis,
          maxRedirects: config.maxRedirects,
          maxResponseBytes: config.maxResponseBytes,
          sensitiveValues: Object.values(credential.headers),
          signal: invocation.signal,
          beforeDispatch: async () => {
            await assertCurrent({
              connectionId,
              expectedProviderKey: 'http',
              expectedAuthType: 'http_headers',
              secretVersionId: resolved.secretVersionId,
              signal: invocation.signal,
            });
            await runtime.beforeDispatch();
          },
        },
        (stream) =>
          consumeResponseBody(
            runtime.artifacts,
            config.inlineResponseBytes,
            config.maxResponseBytes,
            stream,
          ),
      );
    } catch (error: unknown) {
      if (error instanceof HttpRequestExecutorError) throw error;
      if (!(error instanceof SecureHttpError))
        throw new HttpRequestExecutorError(
          Object.freeze({ kind: 'outcome_unknown', errorKind: 'network' }),
          true,
        );
      throw new HttpRequestExecutorError(
        classifySecureHttpError(error, HTTP_SIDE_EFFECT_CLASS.unsafe, false),
        error.possiblyDispatched,
      );
    }
    const decision = classifySecureHttpResponse(
      response.status,
      HTTP_SIDE_EFFECT_CLASS.unsafe,
      false,
    );
    if (decision.kind !== 'succeeded')
      throw new HttpRequestExecutorError(decision, true);
    return httpRequestOutputSchema.parse({
      status: response.status,
      headers: response.headers,
      body: response.body,
      finalOrigin: response.finalUrl,
      redirectCount: response.redirectCount,
    });
  } finally {
    body?.fill(0);
    resolved.secret.fill(0);
  }
}

async function writeArtifact(
  artifacts: NonNullable<
    NodeExecutionInvocation<unknown, unknown>['runtime']
  >['artifacts'],
  body: AsyncIterable<Uint8Array>,
  mediaType: string,
  maxBytes: number,
  signal: AbortSignal,
) {
  if (artifacts === undefined)
    throw new HttpRequestExecutorError(
      Object.freeze({ kind: 'failed', errorKind: 'internal' }),
      true,
    );
  let reference;
  try {
    reference = await artifacts.write({
      body,
      maxBytes,
      mediaType,
      purpose: 'node-output',
      signal,
    });
  } catch {
    throw new HttpRequestExecutorError(
      Object.freeze({ kind: 'failed', errorKind: 'internal' }),
      true,
    );
  }
  return Object.freeze({ kind: 'artifact' as const, ...reference });
}

function concatenate(chunks: readonly Uint8Array[], byteLength: number) {
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function* continueBody(
  buffered: readonly Uint8Array[],
  iterator: AsyncIterator<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  try {
    for (const chunk of buffered) {
      try {
        yield chunk;
      } finally {
        chunk.fill(0);
      }
    }
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      const chunk = next.value;
      try {
        yield chunk;
      } finally {
        chunk.fill(0);
      }
    }
  } finally {
    await iterator.return?.();
  }
}

async function consumeResponseBody(
  artifacts: NonNullable<
    NodeExecutionInvocation<unknown, unknown>['runtime']
  >['artifacts'],
  inlineLimit: number,
  maxBytes: number,
  response: Parameters<Parameters<SecureHttpClient['executeStreaming']>[1]>[0],
) {
  const iterator = response.body[Symbol.asyncIterator]();
  const buffered: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        const bytes = concatenate(buffered, byteLength);
        try {
          return inlineBody(bytes, response.bodyEncoding);
        } finally {
          bytes.fill(0);
          for (const chunk of buffered) chunk.fill(0);
        }
      }
      const chunk = next.value;
      buffered.push(chunk);
      byteLength += chunk.byteLength;
      if (byteLength > inlineLimit)
        return await writeArtifact(
          artifacts,
          continueBody(buffered, iterator),
          response.headers['content-type'] ?? 'application/octet-stream',
          maxBytes,
          response.signal,
        );
    }
  } catch (error: unknown) {
    for (const chunk of buffered) chunk.fill(0);
    await iterator.return?.();
    throw error;
  }
}

export function createHttpRequestExecutorRegistration(
  dependencies: HttpRequestExecutorDependencies,
  lifecycle: NodeExecutorRegistration['lifecycle'] = 'staged',
): NodeExecutorRegistration {
  return Object.freeze({
    abiVersion: DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
    definitions: Object.freeze([HTTP_REQUEST_DEFINITION]),
    executor: HTTP_REQUEST_EXECUTOR,
    lifecycle,
    policyReferences: Object.freeze([
      HTTP_REQUEST_NETWORK_POLICY,
      HTTP_REQUEST_VALUE_POLICY,
    ]),
    execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
      executeHttpRequest(dependencies, invocation),
  });
}
