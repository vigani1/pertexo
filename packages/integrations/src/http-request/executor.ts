import { executePagination } from './pagination/execute.js';

import {
  type NodeVerifiedByteSource,
  type NodeExecutionInvocation,
  type NodeExecutorRegistration,
  FileInputFailure,
  NodeExecutorFailure,
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
} from '@pertexo/node-sdk/server';
import {
  classifySecureHttpError,
  classifySecureHttpResponse,
  HTTP_SIDE_EFFECT_CLASS,
} from '../http/outcome-policy.js';
import { SECURE_HTTP_ERROR_CODE } from '../http/secure.js';
import { inspectSecureHttpError } from '../http/secure-error.js';
import { errorNameIs, safeInstanceOf } from '../http/unknown-error.js';
import {
  HTTP_REQUEST_CONNECTION_SLOT,
  HTTP_REQUEST_EXECUTOR,
} from './definition.js';
import {
  httpRequestConfigSchema,
  httpRequestInputSchema,
  httpRequestOutputSchema,
  type HttpRequestConfig,
  type HttpRequestInput,
  type HttpRequestOutput,
} from './validation.js';

import {
  createProviderBeforeDispatch,
  createUnauthenticatedBeforeDispatch,
} from '../provider-dispatch-fence.js';
import { decodeCredential } from './request-material.js';
import { encodeMultipart } from './multipart/encode.js';
import { readRequestBody } from './read-body.js';
import {
  HttpRequestExecutorError,
  type HttpRequestExecutorDependencies,
  NOOP_HTTP_REQUEST_EXECUTOR_TELEMETRY,
  failedConfiguration,
} from './execution/contract.js';
import { consumeResponseBody, releaseHttpMaterial } from './execution/body.js';
import { requestHeaders, fillPlaceholders } from './execution/input.js';

export {
  HttpRequestExecutorError,
  type HttpRequestExecutorDependencies,
  type HttpRequestExecutorTelemetry,
  NOOP_HTTP_REQUEST_EXECUTOR_TELEMETRY,
} from './execution/contract.js';
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
            repeatable,
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
