import { executePagination } from './pagination/execute.js';
import {
  type NodeExecutionInvocation,
  type NodeExecutorRegistration,
  NodeExecutorFailure,
} from '@pertexo/node-sdk/server';
import {
  classifySecureHttpError,
  classifySecureHttpResponse,
} from '../http/outcome-policy.js';
import { SECURE_HTTP_ERROR_CODE } from '../http/secure.js';
import { inspectSecureHttpError } from '../http/secure-error.js';
import { errorNameIs, safeInstanceOf } from '../http/unknown-error.js';
import { HTTP_REQUEST_EXECUTOR } from './definition.js';
import {
  httpRequestOutputSchema,
  type HttpRequestOutput,
} from './validation.js';
import {
  createProviderBeforeDispatch,
  createUnauthenticatedBeforeDispatch,
} from '../provider-dispatch-fence.js';
import { decodeCredential } from './material.js';
import { serviceResponseFacts } from './execution/service-response.js';

import {
  HttpRequestExecutorError,
  type HttpRequestExecutorDependencies,
  NOOP_HTTP_REQUEST_EXECUTOR_TELEMETRY,
  failedConfiguration,
} from './execution/contract.js';
import { consumeResponseBody, releaseHttpMaterial } from './execution/body.js';
import { requestHeaders } from './execution/input.js';
import {
  type RequestContext,
  type RequestMaterial,
  prepareInvocation,
  prepareRequestBody,
  resolveRequestConnection,
} from './execution/invocation.js';
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
  const context = prepareInvocation(invocation);
  const { runtime, repeatable } = context;
  const dispatch = {
    possiblyDispatched: runtime.providerDispatchUnresolved ?? false,
  };
  const prepared = await prepareRequestBody(context);
  const resolved = await resolveRequestConnection(
    context,
    prepared.body,
    dispatch,
  );
  try {
    return await executeWithMaterial(dependencies, context, {
      ...prepared,
      resolved,
      dispatch,
    });
  } finally {
    await releaseHttpMaterial(prepared.body, resolved?.secret, {
      repeatable,
      possiblyDispatched: dispatch.possiblyDispatched,
    });
  }
}

async function executeWithMaterial(
  dependencies: HttpRequestExecutorDependencies,
  context: RequestContext,
  material: RequestMaterial,
): Promise<HttpRequestOutput> {
  const {
    config,
    runtime,
    connections,
    connectionId,
    repeatable,
    sideEffect,
    invocation,
  } = context;
  const { body, resolved, dispatch } = material;
  const { credential, headers } = prepareHeaders(context, material);
  const sensitiveValues = [
    ...credentialSensitiveValues(credential.headers),
    ...(invocation.runtime?.callbacks?.sensitiveValues() ?? []),
  ];
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
      sensitiveValues,
      signal: invocation.signal,
      beforeDispatch: async () => {
        await beforeDispatch();
        dispatch.possiblyDispatched = true;
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
            const decision = classifySecureHttpResponse(status, sideEffect, {
              providerKeyPresent: false,
              headers: responseHeaders,
            });
            if (decision.kind !== 'succeeded')
              throw new HttpRequestExecutorError(decision, {
                possiblyDispatched: false,
                serviceResponse: serviceResponseFacts(
                  config,
                  { status },
                  request.sensitiveValues,
                ),
              });
          },
        }),
      );
    response = await dependencies.httpClient.executeStreaming(
      request,
      (stream) =>
        consumeResponseBody(runtime.artifacts, {
          inlineLimit: config.inlineResponseBytes,
          maxBytes: config.maxResponseBytes,
          response: stream,
          repeatable,
        }),
    );
  } catch (error: unknown) {
    rethrowHttpError(error, context);
  }

  const decision = classifySecureHttpResponse(response.status, sideEffect, {
    providerKeyPresent: false,
    headers: response.headers,
  });
  // Like n8n's "Never error": the service answered, and the person asked
  // to branch on its answer rather than fail.
  if (
    decision.kind !== 'succeeded' &&
    !((config.returnErrorResponses ?? false) && response.status >= 300)
  )
    throw new HttpRequestExecutorError(decision, {
      possiblyDispatched: !repeatable,
      serviceResponse: serviceResponseFacts(config, response, sensitiveValues),
    });
  return httpRequestOutputSchema.parse({
    status: response.status,
    headers: response.headers,
    body: response.body,
    finalOrigin: response.finalUrl,
    redirectCount: response.redirectCount,
  });
}

/** A service can echo a token without its scheme, so both forms are secret. */
function credentialSensitiveValues(
  headers: Readonly<Record<string, string>>,
): readonly string[] {
  return Object.values(headers).flatMap((value) => {
    const token = /^\S+\s+(\S{8,})$/u.exec(value)?.[1];
    return token === undefined ? [value] : [value, token];
  });
}

function rethrowHttpError(
  error: unknown,
  { config, invocation, runtime, repeatable, sideEffect }: RequestContext,
): never {
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
      { possiblyDispatched: false },
    );
  const secureError = inspectSecureHttpError(error);
  if (secureError === undefined)
    throw new HttpRequestExecutorError(
      repeatable
        ? Object.freeze({ kind: 'failed', errorKind: 'internal' })
        : Object.freeze({ kind: 'outcome_unknown', errorKind: 'network' }),
      { possiblyDispatched: !repeatable },
    );
  if (!repeatable && (runtime.providerDispatchUnresolved ?? false))
    throw new HttpRequestExecutorError(
      Object.freeze({ kind: 'outcome_unknown', errorKind: 'provider' }),
      { possiblyDispatched: true },
    );
  if (secureError.code === SECURE_HTTP_ERROR_CODE.connectionFenceFailed)
    throw new HttpRequestExecutorError(
      Object.freeze({ kind: 'failed', errorKind: 'authentication' }),
      { possiblyDispatched: false },
    );
  if (secureError.code === SECURE_HTTP_ERROR_CODE.dispatchBindingMismatch)
    throw failedConfiguration();
  throw new HttpRequestExecutorError(
    classifySecureHttpError(secureError.error, sideEffect, {
      providerKeyPresent: false,
    }),
    { possiblyDispatched: !repeatable && secureError.possiblyDispatched },
  );
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

function prepareHeaders(context: RequestContext, material: RequestMaterial) {
  const { config, input, runtime, connectionId } = context;
  const { resolved, multipartContentType } = material;
  const credentialBindingMismatch =
    resolved !== undefined &&
    (resolved.connectionId !== connectionId ||
      resolved.providerKey !== 'http' ||
      resolved.authType !== 'http_headers');
  if (credentialBindingMismatch) throw failedConfiguration();
  const credential =
    resolved === undefined
      ? { headers: Object.freeze({}) }
      : decodeCredential(
          resolved.secret,
          () =>
            new HttpRequestExecutorError(
              Object.freeze({ kind: 'failed', errorKind: 'authentication' }),
              { possiblyDispatched: false },
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
      (runtime.providerDispatchUnresolved ?? false)
    )
      throw new HttpRequestExecutorError(
        Object.freeze({ kind: 'outcome_unknown', errorKind: 'provider' }),
        { possiblyDispatched: true },
      );
    throw error;
  }
  return { credential, headers };
}
