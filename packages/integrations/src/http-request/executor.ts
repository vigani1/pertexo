import { Buffer } from 'node:buffer';

import {
  DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  type NodeExecutionInvocation,
  type NodeExecutorRegistration,
  NodeExecutorFailure,
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
} from '@pertexo/node-sdk/server';
import type { z } from 'zod';

import {
  classifySecureHttpError,
  classifySecureHttpResponse,
  HTTP_SIDE_EFFECT_CLASS,
  type HttpOutcomeDecision,
} from '../http/outcome-policy.js';
import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  type SecureHttpClient,
} from '../http/secure-http.js';
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
  resolvedHttpHeadersCredentialSchema,
  type HttpRequestOutput,
} from './validation.js';
import { createProviderBeforeDispatch } from '../provider-dispatch-fence.js';

export class HttpRequestExecutorError extends NodeExecutorFailure {
  public override readonly name = 'HttpRequestExecutorError';
  public override readonly cause: unknown;

  public constructor(
    public readonly decision: HttpOutcomeDecision,
    possiblyDispatched: boolean,
    cause?: unknown,
  ) {
    if (decision.kind === 'succeeded')
      throw new TypeError('Successful HTTP outcome');
    super({
      kind: decision.kind,
      errorKind: decision.errorKind,
      possiblyDispatched,
    });
    this.cause = cause;
  }
}

export type HttpRequestExecutorDependencies = Readonly<{
  httpClient: Pick<SecureHttpClient, 'executeStreaming'>;
  telemetry?: HttpRequestExecutorTelemetry;
}>;

export interface HttpRequestExecutorTelemetry {
  measure(work: () => Promise<HttpRequestOutput>): Promise<HttpRequestOutput>;
}

export const NOOP_HTTP_REQUEST_EXECUTOR_TELEMETRY: HttpRequestExecutorTelemetry =
  Object.freeze({
    measure: (work: () => Promise<HttpRequestOutput>) => work(),
  });

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
    return resolvedHttpHeadersCredentialSchema.parse(
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
  let config: z.output<typeof httpRequestConfigSchema>;
  let input: z.output<typeof httpRequestInputSchema>;
  try {
    // Executors are also callable as isolated adapter boundaries, so they
    // retain fail-closed parsing even though createNodeRegistry parses first.
    config = httpRequestConfigSchema.parse(invocation.config);
    input = httpRequestInputSchema.parse(invocation.input);
  } catch {
    throw failedConfiguration();
  }
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
  const body = requestBody(input, config.method);

  let resolved;
  try {
    resolved = await connections.resolve({
      connectionId,
      expectedProviderKey: 'http',
      expectedAuthType: 'http_headers',
      purpose: 'http.request.execute',
      signal: invocation.signal,
    });
  } catch (error: unknown) {
    body?.fill(0);
    if (runtime.providerDispatchUnresolved === true)
      throw new HttpRequestExecutorError(
        Object.freeze({ kind: 'outcome_unknown', errorKind: 'provider' }),
        true,
      );
    if (error instanceof ProviderExecutionRateLimitError)
      throw new HttpRequestExecutorError(
        Object.freeze({
          kind: 'retry',
          errorKind: 'rate_limit',
          reuseProviderKey: false,
        }),
        false,
      );
    if (error instanceof ProviderCredentialInvalidError)
      throw new HttpRequestExecutorError(
        Object.freeze({ kind: 'failed', errorKind: 'authentication' }),
        false,
      );
    if (
      invocation.signal.aborted ||
      (error instanceof Error && error.name === 'AbortError')
    )
      throw new HttpRequestExecutorError(
        Object.freeze({ kind: 'canceled', errorKind: 'canceled' }),
        false,
      );
    throw new HttpRequestExecutorError(
      Object.freeze({
        kind: 'retry',
        errorKind: 'provider',
        reuseProviderKey: false,
      }),
      false,
    );
  }
  try {
    if (
      resolved.connectionId !== connectionId ||
      resolved.providerKey !== 'http' ||
      resolved.authType !== 'http_headers'
    )
      throw failedConfiguration();
    const credential = decodeCredential(resolved.secret);
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
          beforeDispatch: createProviderBeforeDispatch({
            assertCurrent,
            connectionId,
            expectedProviderKey: 'http',
            expectedAuthType: 'http_headers',
            secretVersionId: resolved.secretVersionId,
            signal: invocation.signal,
            runtime,
          }),
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
      if (runtime.providerDispatchUnresolved === true)
        throw new HttpRequestExecutorError(
          Object.freeze({ kind: 'outcome_unknown', errorKind: 'provider' }),
          true,
        );
      if (error.code === SECURE_HTTP_ERROR_CODE.connectionFenceFailed)
        throw new HttpRequestExecutorError(
          Object.freeze({ kind: 'failed', errorKind: 'authentication' }),
          false,
        );
      if (error.code === SECURE_HTTP_ERROR_CODE.dispatchBindingMismatch)
        throw failedConfiguration();
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
      Object.freeze({ kind: 'outcome_unknown', errorKind: 'provider' }),
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
  } catch (error) {
    throw new HttpRequestExecutorError(
      Object.freeze({ kind: 'outcome_unknown', errorKind: 'provider' }),
      true,
      error,
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

type BodyFailure = Readonly<{ error: unknown; failed: boolean }>;
const NO_BODY_FAILURE: BodyFailure = Object.freeze({
  error: undefined,
  failed: false,
});

async function preserveBodyFailureDuringCleanup(
  primary: BodyFailure,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch (cleanupError) {
    if (primary.failed)
      throw new AggregateError(
        [primary.error, cleanupError],
        'HTTP response body failed and its iterator cleanup was incomplete',
      );
    throw cleanupError instanceof Error
      ? cleanupError
      : new Error('HTTP response body cleanup failed', {
          cause: cleanupError,
        });
  }
}

async function* continueBody(
  buffered: readonly Uint8Array[],
  iterator: AsyncIterator<Uint8Array>,
  markCleanupStarted: () => void,
): AsyncGenerator<Uint8Array> {
  let primary: BodyFailure = NO_BODY_FAILURE;
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
  } catch (error) {
    primary = { error, failed: true };
    throw error;
  } finally {
    markCleanupStarted();
    await preserveBodyFailureDuringCleanup(primary, async () => {
      await iterator.return?.();
    });
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
  const bodyOwnership = { cleanupStarted: false };
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
      if (byteLength > inlineLimit) {
        return await writeArtifact(
          artifacts,
          continueBody(buffered, iterator, () => {
            bodyOwnership.cleanupStarted = true;
          }),
          response.headers['content-type'] ?? 'application/octet-stream',
          maxBytes,
          response.signal,
        );
      }
    }
  } catch (error: unknown) {
    for (const chunk of buffered) chunk.fill(0);
    if (!bodyOwnership.cleanupStarted)
      await preserveBodyFailureDuringCleanup(
        { error, failed: true },
        async () => {
          bodyOwnership.cleanupStarted = true;
          await iterator.return?.();
        },
      );
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
      (dependencies.telemetry ?? NOOP_HTTP_REQUEST_EXECUTOR_TELEMETRY).measure(
        () => executeHttpRequest(dependencies, invocation),
      ),
  });
}
