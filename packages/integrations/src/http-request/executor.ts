import { Buffer } from 'node:buffer';
import { executePagination } from './pagination/execute.js';
import { JSON_MEDIA_TYPE } from '../http/content-type.js';

import {
  type JsonValue,
  type NodeVerifiedByteSource,
  type NodeExecutionInvocation,
  type NodeExecutorRegistration,
  canonicalizeBoundedJson,
  FileInputFailure,
  NodeExecutorFailure,
  NodeInputValidationError,
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
} from '@pertexo/node-sdk/server';
import {
  classifySecureHttpError,
  classifySecureHttpResponse,
  HTTP_SIDE_EFFECT_CLASS,
  type HttpOutcomeDecision,
} from '../http/outcome-policy.js';
import {
  SECURE_HTTP_ERROR_CODE,
  type SecureHttpClient,
} from '../http/secure.js';
import { inspectSecureHttpError } from '../http/secure-error.js';
import { errorNameIs, safeInstanceOf } from '../http/unknown-error.js';
import {
  HTTP_REQUEST_CONNECTION_SLOT,
  HTTP_REQUEST_EXECUTOR,
} from './definition.js';
import {
  HTTP_REQUEST_LIMITS,
  httpRequestConfigSchema,
  httpRequestInputSchema,
  httpRequestOutputSchema,
  safeRequestUrl,
  type HttpRequestConfig,
  type HttpRequestInput,
  type HttpRequestOutput,
} from './validation.js';
import {
  fillHttpTemplate,
  HTTP_PLACEHOLDER_NAME,
  HttpPlaceholderError,
  type HttpPlaceholderValue,
} from './placeholders.js';
import {
  createProviderBeforeDispatch,
  createUnauthenticatedBeforeDispatch,
} from '../provider-dispatch-fence.js';
import { decodeCredential, mergeHeaders } from './request-material.js';
import { encodeMultipart } from './multipart/encode.js';
import { readRequestBody, artifactContentType } from './read-body.js';

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
      ...(decision.kind === 'retry' &&
      decision.minimumRetryDelayMillis !== undefined
        ? { minimumRetryDelayMillis: decision.minimumRetryDelayMillis }
        : {}),
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

// Leaves room in the step's 1 MiB, 10,000-member output for the text and
// headers the parsed value sits beside.
const PARSED_JSON_LIMITS = Object.freeze({
  bytes: 262_144,
  depth: 48,
  members: 8_000,
});

/** A JSON response later steps can map into; absent when it doesn't fit. */
function parsedJson(text: string): Readonly<{ json?: JsonValue }> {
  try {
    return {
      json: canonicalizeBoundedJson(JSON.parse(text), PARSED_JSON_LIMITS),
    };
  } catch {
    return {};
  }
}

function inlineBody(
  bytes: Uint8Array,
  preferred: 'base64' | 'utf8',
  mediaType: string | undefined,
) {
  if (preferred === 'utf8') {
    let value: string | undefined;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // Invalid text is represented exactly as base64.
    }
    if (value !== undefined)
      return Object.freeze({
        kind: 'inline' as const,
        encoding: 'utf8' as const,
        value,
        byteLength: bytes.byteLength,
        ...(mediaType !== undefined && JSON_MEDIA_TYPE.test(mediaType)
          ? parsedJson(value)
          : {}),
      });
  }
  return Object.freeze({
    kind: 'inline' as const,
    encoding: 'base64' as const,
    value: Buffer.from(bytes).toString('base64'),
    byteLength: bytes.byteLength,
  });
}

function requestHeaders(
  input: HttpRequestInput,
  configured: Readonly<Record<string, string>>,
  credential: Readonly<Record<string, string>>,
  multipartContentType: string | undefined,
): Readonly<Record<string, string>> {
  const headers = mergeHeaders(configured, credential, failedConfiguration);
  if (multipartContentType === undefined)
    return artifactContentType(input, headers);
  if (Object.hasOwn(headers, 'content-type'))
    throw new FileInputFailure({ reason: 'multipart_content_type' });
  return { ...headers, 'content-type': multipartContentType };
}

/**
 * Split the {placeholder} values from the body inputs and fill the address
 * and header values. The filled address keeps the configured origin.
 */
function fillPlaceholders(
  configured: HttpRequestConfig,
  mapped: HttpRequestInput,
): Readonly<{ config: HttpRequestConfig; input: HttpRequestInput }> {
  const values: Record<string, HttpPlaceholderValue> = {};
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mapped))
    if (
      key !== 'body' &&
      HTTP_PLACEHOLDER_NAME.test(key) &&
      (typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean')
    )
      values[key] = value;
    else input[key] = value;
  let filled;
  try {
    filled = fillHttpTemplate(configured, values);
  } catch (error) {
    if (error instanceof HttpPlaceholderError)
      throw new NodeInputValidationError(error.message);
    throw error;
  }
  if (
    !safeRequestUrl(filled.url) ||
    new TextEncoder().encode(filled.url).byteLength >
      HTTP_REQUEST_LIMITS.maxUrlBytes ||
    new URL(filled.url).origin !== new URL(configured.url).origin
  )
    throw new NodeInputValidationError(
      'The filled-in address is too long or no longer a safe address; check the values mapped into it.',
    );
  return {
    config: { ...configured, url: filled.url, headers: filled.headers },
    input: input as HttpRequestInput,
  };
}

async function executeHttpRequest(
  dependencies: HttpRequestExecutorDependencies,
  invocation: NodeExecutionInvocation<unknown, unknown>,
): Promise<HttpRequestOutput> {
  let configured: HttpRequestConfig;
  let mapped: HttpRequestInput;
  try {
    // Executors are also callable as isolated adapter boundaries, so they
    // retain fail-closed parsing even though createNodeRegistry parses first.
    configured = httpRequestConfigSchema.parse(invocation.config);
    mapped = httpRequestInputSchema.parse(invocation.input);
  } catch {
    throw failedConfiguration();
  }
  const { config, input } = fillPlaceholders(configured, mapped);
  const runtime = invocation.runtime;
  if (runtime === undefined) throw failedConfiguration();
  const connections = runtime.connections;
  // The connection is optional: a public API needs no auth headers.
  const connectionId = invocation.connectionRefs[HTTP_REQUEST_CONNECTION_SLOT];
  if (
    (connectionId !== undefined && connections?.assertCurrent === undefined) ||
    runtime.sideEffectClass !== 'unsafe' ||
    runtime.providerIdempotencyKey !== undefined ||
    Object.keys(invocation.connectionRefs).some(
      (slot) => slot !== HTTP_REQUEST_CONNECTION_SLOT,
    )
  )
    throw failedConfiguration();
  // GET and HEAD only read (RFC 9110 §9.2.1), so a repeat can't cause a side
  // effect: their failures retry and can follow a failure link instead of
  // leaving the outcome unknown.
  const repeatable = config.method === 'GET' || config.method === 'HEAD';
  const sideEffect = repeatable
    ? HTTP_SIDE_EFFECT_CLASS.safe
    : HTTP_SIDE_EFFECT_CLASS.unsafe;
  let body: Uint8Array | NodeVerifiedByteSource | undefined;
  let multipartContentType: string | undefined;
  let possiblyDispatched = runtime.providerDispatchUnresolved === true;
  try {
    if (config.multipart !== undefined) {
      const encoded = await encodeMultipart({
        config: config.multipart,
        values: input,
        artifacts: runtime.artifacts,
        signal: invocation.signal,
      });
      body = encoded.body;
      multipartContentType = encoded.contentType;
    } else {
      if (Object.keys(input).some((key) => key !== 'body'))
        throw new FileInputFailure({ reason: 'multipart_values' });
      body = await readRequestBody(
        input,
        config.method,
        runtime.artifacts,
        invocation.signal,
        failedConfiguration,
      );
    }
  } catch (error) {
    if (runtime.providerDispatchUnresolved === true)
      throw new HttpRequestExecutorError(
        Object.freeze({ kind: 'outcome_unknown', errorKind: 'provider' }),
        true,
      );
    throw error;
  }

  let resolved:
    Awaited<ReturnType<NonNullable<typeof connections>['resolve']>> | undefined;
  if (connectionId !== undefined && connections !== undefined)
    try {
      resolved = await connections.resolve({
        connectionId,
        expectedProviderKey: 'http',
        expectedAuthType: 'http_headers',
        purpose: 'http.request.execute',
        signal: invocation.signal,
      });
    } catch (error: unknown) {
      await releaseHttpMaterial(
        body,
        undefined,
        repeatable,
        possiblyDispatched,
      );
      if (!repeatable && runtime.providerDispatchUnresolved === true)
        throw new HttpRequestExecutorError(
          Object.freeze({ kind: 'outcome_unknown', errorKind: 'provider' }),
          true,
        );
      if (safeInstanceOf(error, ProviderExecutionRateLimitError))
        throw new HttpRequestExecutorError(
          Object.freeze({
            kind: 'retry',
            errorKind: 'rate_limit',
            reuseProviderKey: false,
          }),
          false,
        );
      if (safeInstanceOf(error, ProviderCredentialInvalidError))
        throw new HttpRequestExecutorError(
          Object.freeze({ kind: 'failed', errorKind: 'authentication' }),
          false,
        );
      if (invocation.signal.aborted || errorNameIs(error, 'AbortError'))
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
      resolved !== undefined &&
      (resolved.connectionId !== connectionId ||
        resolved.providerKey !== 'http' ||
        resolved.authType !== 'http_headers')
    )
      throw failedConfiguration();
    const credential =
      resolved === undefined
        ? { headers: Object.freeze({}) }
        : decodeCredential(
            resolved.secret,
            () =>
              new HttpRequestExecutorError(
                Object.freeze({ kind: 'failed', errorKind: 'authentication' }),
                false,
              ),
          );
    let headers: Readonly<Record<string, string>>;
    try {
      headers = requestHeaders(
        input,
        config.headers,
        credential.headers,
        multipartContentType,
      );
    } catch (error) {
      if (
        multipartContentType !== undefined &&
        runtime.providerDispatchUnresolved === true
      )
        throw new HttpRequestExecutorError(
          Object.freeze({ kind: 'outcome_unknown', errorKind: 'provider' }),
          true,
        );
      throw error;
    }
    let marked = false;
    const dispatchRuntime =
      config.pagination === undefined
        ? runtime
        : {
            ...runtime,
            beforeDispatch: async (
              evidence?: Parameters<typeof runtime.beforeDispatch>[0],
            ) => {
              if (marked) return;
              await runtime.beforeDispatch(evidence);
              marked = true;
            },
          };
    let response;
    try {
      const beforeDispatch =
        resolved === undefined ||
        connectionId === undefined ||
        connections?.assertCurrent === undefined
          ? createUnauthenticatedBeforeDispatch(dispatchRuntime)
          : createProviderBeforeDispatch({
              assertCurrent: connections.assertCurrent,
              connectionId,
              expectedProviderKey: 'http',
              expectedAuthType: 'http_headers',
              secretVersionId: resolved.secretVersionId,
              signal: invocation.signal,
              runtime: dispatchRuntime,
            });
      const request = {
        url: config.url,
        method: config.method,
        headers,
        ...(body === undefined ? {} : { body }),
        timeoutMillis: config.timeoutMillis,
        maxRedirects: config.maxRedirects,
        maxResponseBytes: config.maxResponseBytes,
        sensitiveValues: [
          ...Object.values(credential.headers),
          ...(invocation.runtime?.callbacks?.sensitiveValues() ?? []),
        ],
        signal: invocation.signal,
        beforeDispatch: async () => {
          await beforeDispatch();
          possiblyDispatched = true;
        },
      };
      if (config.pagination !== undefined)
        return httpRequestOutputSchema.parse(
          await executePagination({
            client: dependencies.httpClient,
            request,
            pagination: config.pagination,
            ...(runtime.artifacts === undefined
              ? {}
              : { artifacts: runtime.artifacts }),
            inlineBytes: config.inlineResponseBytes,
            ...(runtime.deadlineAt === undefined
              ? {}
              : { deadlineAt: runtime.deadlineAt }),
            checkResponse: (status, responseHeaders) => {
              const decision = classifySecureHttpResponse(
                status,
                sideEffect,
                false,
                responseHeaders,
              );
              if (decision.kind !== 'succeeded')
                throw new HttpRequestExecutorError(decision, false);
            },
          }),
        );
      response = await dependencies.httpClient.executeStreaming(
        request,
        (stream) =>
          consumeResponseBody(
            runtime.artifacts,
            config.inlineResponseBytes,
            config.maxResponseBytes,
            stream,
          ),
      );
    } catch (error: unknown) {
      if (
        safeInstanceOf(error, HttpRequestExecutorError) ||
        (config.pagination !== undefined &&
          safeInstanceOf(error, NodeExecutorFailure))
      )
        throw error;
      if (
        config.pagination !== undefined &&
        (invocation.signal.aborted || errorNameIs(error, 'AbortError'))
      )
        throw new HttpRequestExecutorError(
          { kind: 'canceled', errorKind: 'canceled' },
          false,
        );
      const secureError = inspectSecureHttpError(error);
      if (secureError === undefined)
        throw new HttpRequestExecutorError(
          repeatable
            ? Object.freeze({ kind: 'failed', errorKind: 'internal' })
            : Object.freeze({ kind: 'outcome_unknown', errorKind: 'network' }),
          !repeatable,
        );
      if (!repeatable && runtime.providerDispatchUnresolved === true)
        throw new HttpRequestExecutorError(
          Object.freeze({ kind: 'outcome_unknown', errorKind: 'provider' }),
          true,
        );
      if (secureError.code === SECURE_HTTP_ERROR_CODE.connectionFenceFailed)
        throw new HttpRequestExecutorError(
          Object.freeze({ kind: 'failed', errorKind: 'authentication' }),
          false,
        );
      if (secureError.code === SECURE_HTTP_ERROR_CODE.dispatchBindingMismatch)
        throw failedConfiguration();
      throw new HttpRequestExecutorError(
        classifySecureHttpError(secureError.error, sideEffect, false),
        !repeatable && secureError.possiblyDispatched,
      );
    }
    const decision = classifySecureHttpResponse(
      response.status,
      sideEffect,
      false,
      response.headers,
    );
    // Like n8n's "Never error": the service answered, and the person asked
    // to branch on its answer rather than fail.
    if (
      decision.kind !== 'succeeded' &&
      !(config.returnErrorResponses === true && response.status >= 300)
    )
      throw new HttpRequestExecutorError(decision, !repeatable);
    return httpRequestOutputSchema.parse({
      status: response.status,
      headers: response.headers,
      body: response.body,
      finalOrigin: response.finalUrl,
      redirectCount: response.redirectCount,
    });
  } finally {
    await releaseHttpMaterial(
      body,
      resolved?.secret,
      repeatable,
      possiblyDispatched,
    );
  }
}

async function releaseRequestBody(
  body: Uint8Array | NodeVerifiedByteSource | undefined,
): Promise<void> {
  if (body instanceof Uint8Array) body.fill(0);
  else await body?.release();
}

async function writeArtifact(
  artifacts: NonNullable<
    NodeExecutionInvocation<unknown, unknown>['runtime']
  >['artifacts'],
  body: AsyncIterable<Uint8Array>,
  mediaType: string,
  maxBytes: number,
  signal: AbortSignal,
  cancelSource?: (reason: Error) => void,
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
      ...(cancelSource === undefined ? {} : { cancelSource }),
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
    throw safeInstanceOf(cleanupError, Error)
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
          return inlineBody(
            bytes,
            response.bodyEncoding,
            response.headers['content-type'],
          );
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
          response.cancelSource,
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
): NodeExecutorRegistration {
  return Object.freeze({
    executor: HTTP_REQUEST_EXECUTOR,
    execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
      (dependencies.telemetry ?? NOOP_HTTP_REQUEST_EXECUTOR_TELEMETRY).measure(
        () => executeHttpRequest(dependencies, invocation),
      ),
  });
}

async function releaseHttpMaterial(
  body: Uint8Array | NodeVerifiedByteSource | undefined,
  secret: Uint8Array | undefined,
  repeatable: boolean,
  possiblyDispatched: boolean,
): Promise<void> {
  try {
    await releaseRequestBody(body);
  } catch (error) {
    if (!repeatable && possiblyDispatched)
      throw new HttpRequestExecutorError(
        { kind: 'outcome_unknown', errorKind: 'provider' },
        true,
      );
    throw error;
  } finally {
    secret?.fill(0);
  }
}
