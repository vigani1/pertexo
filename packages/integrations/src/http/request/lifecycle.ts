import { markingDispatchOnce } from '../../providers/provider-dispatch-fence.js';
import { executePagination } from './pagination/execute.js';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import {
  classifySecureHttpError,
  classifySecureHttpResponse,
} from '../outcome-policy.js';

import { PROVIDER_HTTP_ERROR_CODE } from '../../providers/http.errors.js';
import { inspectProviderHttpError } from '../../providers/http.errors.js';
import { errorNameIs, safeInstanceOf } from '@pertexo/node-sdk/server';
import {
  httpRequestOutputSchema,
  type HttpRequestOutput,
} from './request.schemas.js';
import {
  createProviderBeforeDispatch,
  createUnauthenticatedBeforeDispatch,
} from '../../providers/provider-dispatch-fence.js';
import { serviceResponseFacts } from './execution/service-response.js';
import { OAuth2TokenFailure } from '../../oauth2/oauth2.errors.js';
import { HttpOAuth2Failure } from './execution/oauth2-renewal.errors.js';

import {
  failedConfiguration,
  HttpRequestExecutorError,
} from './request.errors.js';
import type { ProviderHttpClient } from '../../providers/http-client.js';
import { consumeResponseBody, releaseHttpMaterial } from './execution/body.js';
import { requestHeaders } from './execution/request-input.js';
import {
  type RequestContext,
  type RequestMaterial,
  type RequestCredentialMaterial,
  credentialFailure,
  prepareRequestBody,
  resolveRequestConnection,
} from './execution/invocation.js';
import { credentialSensitiveValues } from './execution/credentials.js';
import { requestClient } from './execution/request-client.js';

export async function executeHttpRequest(
  httpClient: Pick<ProviderHttpClient, 'executeStreaming' | 'redactText'>,
  context: RequestContext,
  withTestCredential?: (
    run: (credential: RequestCredentialMaterial) => Promise<HttpRequestOutput>,
  ) => Promise<HttpRequestOutput>,
): Promise<HttpRequestOutput> {
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
  const run = (credential?: RequestCredentialMaterial) =>
    executeWithMaterial(httpClient, context, {
      ...prepared,
      resolved,
      dispatch,
      ...(credential === undefined ? {} : { credential }),
      credentialTest: withTestCredential !== undefined,
    });
  try {
    const { binding, connectionId } = context;
    if (withTestCredential !== undefined) return await withTestCredential(run);
    if (
      binding === undefined ||
      connectionId === undefined ||
      resolved === undefined
    )
      return await run();
    return await binding.withHeaders(resolved, connectionId, run);
  } finally {
    await releaseHttpMaterial(prepared.body, {
      repeatable,
      possiblyDispatched: dispatch.possiblyDispatched,
    });
  }
}

async function executeWithMaterial(
  httpClient: Pick<ProviderHttpClient, 'executeStreaming' | 'redactText'>,
  context: RequestContext,
  material: RequestMaterial,
): Promise<HttpRequestOutput> {
  const {
    config,
    runtime,
    connections,
    connectionId,
    binding,
    approvedOrigin,
    repeatable,
    sideEffect,
    invocation,
  } = context;
  const { body, resolved, dispatch, credentialTest } = material;
  const headers = prepareHeaders(context, material);
  const oauth2 =
    resolved !== undefined && 'accessToken' in resolved ? resolved : undefined;
  const sensitiveValues = [
    ...credentialSensitiveValues(material.credential?.headers ?? {}),
    ...(material.credential?.sensitiveValues ?? []),
    ...(invocation.runtime?.callbacks?.sensitiveValues() ?? []),
  ];
  // A paged request and a renewed one dispatch more than once, as one attempt.
  const dispatchRuntime =
    config.pagination === undefined && oauth2 === undefined
      ? runtime
      : markingDispatchOnce(runtime);
  let response;
  try {
    const beforeDispatch =
      binding === undefined ||
      resolved === undefined ||
      connectionId === undefined ||
      connections?.assertCurrent === undefined
        ? createUnauthenticatedBeforeDispatch(dispatchRuntime)
        : createProviderBeforeDispatch({
            assertCurrent: connections.assertCurrent,
            connectionId,
            expectedProviderKey: binding.providerKey,
            expectedAuthType: resolved.authType,
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
      ...(approvedOrigin === undefined ? {} : { publicOnly: true as const }),
      maxResponseBytes: config.maxResponseBytes,
      sensitiveValues,
      signal: invocation.signal,
      beforeDispatch: async () => {
        await beforeDispatch();
        dispatch.possiblyDispatched = true;
      },
    };
    const client = requestClient(
      httpClient,
      {
        connections,
        connectionId,
        signal: invocation.signal,
        onCredentialError: (error) => credentialFailure(error, context),
      },
      oauth2,
    );
    if (config.pagination !== undefined)
      return httpRequestOutputSchema.parse(
        await executePagination({
          client,
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
                  httpClient.redactText,
                  config,
                  { status },
                  request.sensitiveValues,
                ),
              });
          },
        }),
      );
    response = await client.executeStreaming(request, (stream) =>
      consumeResponseBody(runtime.artifacts, {
        inlineLimit: config.inlineResponseBytes,
        maxBytes: config.maxResponseBytes,
        response: stream,
        repeatable,
      }),
    );
  } catch (error: unknown) {
    if (credentialTest && inspectProviderHttpError(error) !== undefined)
      throw error;
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
      serviceResponse: serviceResponseFacts(
        httpClient.redactText,
        config,
        response,
        sensitiveValues,
      ),
    });
  return httpRequestOutputSchema.parse({
    status: response.status,
    headers: response.headers,
    body: response.body,
    finalOrigin: response.finalUrl,
    redirectCount: response.redirectCount,
  });
}

function rethrowHttpError(error: unknown, context: RequestContext): never {
  const { config, invocation, runtime, repeatable, sideEffect } = context;
  if (safeInstanceOf(error, OAuth2TokenFailure))
    throw credentialFailure(error, context);
  if (
    safeInstanceOf(error, HttpRequestExecutorError) ||
    safeInstanceOf(error, HttpOAuth2Failure) ||
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
  const secureError = inspectProviderHttpError(error);
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
      { possiblyDispatched: true, responseCode: secureError.code },
    );
  if (secureError.code === PROVIDER_HTTP_ERROR_CODE.connectionFenceFailed)
    throw new HttpRequestExecutorError(
      Object.freeze({ kind: 'failed', errorKind: 'authentication' }),
      { possiblyDispatched: false },
    );
  if (secureError.code === PROVIDER_HTTP_ERROR_CODE.dispatchBindingMismatch)
    throw failedConfiguration();
  throw new HttpRequestExecutorError(
    classifySecureHttpError(secureError.error, sideEffect, {
      providerKeyPresent: false,
    }),
    {
      possiblyDispatched: !repeatable && secureError.possiblyDispatched,
      responseCode: secureError.code,
    },
  );
}

function prepareHeaders(context: RequestContext, material: RequestMaterial) {
  const { config, input, runtime } = context;
  const { multipartContentType, credential } = material;
  try {
    return requestHeaders(
      input,
      config.headers,
      credential?.headers ?? {},
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
}
