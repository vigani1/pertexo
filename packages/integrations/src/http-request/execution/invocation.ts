import {
  type NodeVerifiedByteSource,
  type NodeExecutionInvocation,
  FileInputFailure,
  type NodeExecutorFailure,
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
} from '@pertexo/node-sdk/server';
import { HTTP_SIDE_EFFECT_CLASS } from '../../http/outcome-policy.js';
import { OAuth2TokenFailure } from '../../oauth2/contract.js';

import { errorNameIs, safeInstanceOf } from '../../http/unknown-error.js';
import { HTTP_REQUEST_CONNECTION_SLOT } from '../definition.js';
import type { HttpRequestConfig, HttpRequestInput } from '../validation.js';

import { encodeMultipart } from '../multipart/encode.js';
import { readRequestBody } from '../read-body.js';
import { HttpRequestExecutorError, failedConfiguration } from './contract.js';
import { releaseHttpMaterial } from './body.js';
import { fillPlaceholders } from './input.js';
import { HttpOAuth2Failure } from './oauth2-failure.js';

export type RequestContext = ReturnType<typeof prepareInvocation>;

interface DispatchState {
  possiblyDispatched: boolean;
}

type PreparedBody = Awaited<ReturnType<typeof prepareRequestBody>>;

export type RequestMaterial = PreparedBody &
  Readonly<{
    resolved: Awaited<ReturnType<typeof resolveRequestConnection>>;
    dispatch: DispatchState;
  }>;

export function prepareInvocation(
  invocation: NodeExecutionInvocation<unknown, unknown>,
) {
  // The registry has already parsed both against the definition's schemas.
  const { config, input } = fillPlaceholders(
    invocation.config as HttpRequestConfig,
    invocation.input as HttpRequestInput,
  );
  const runtime = invocation.runtime;
  if (runtime === undefined) throw failedConfiguration();
  const connections = runtime.connections;
  // The connection is optional: a public API needs no auth headers.
  const connectionId = invocation.connectionRefs[HTTP_REQUEST_CONNECTION_SLOT];
  // GET and HEAD only read (RFC 9110 §9.2.1), so a repeat can't cause a side
  // effect: their failures retry and can follow a failure link instead of
  // leaving the outcome unknown.
  const repeatable = config.method === 'GET' || config.method === 'HEAD';
  // An attempt planned before classes came from the method still says unsafe.
  const expectedClass =
    runtime.sideEffectClass === 'unsafe' ||
    (repeatable && runtime.sideEffectClass === 'safe');
  const invalidDispatchRuntime =
    (connectionId !== undefined &&
      (connections?.assertCurrent === undefined ||
        connections.resolveHttpCredential === undefined)) ||
    !expectedClass ||
    runtime.providerIdempotencyKey !== undefined ||
    Object.keys(invocation.connectionRefs).some(
      (slot) => slot !== HTTP_REQUEST_CONNECTION_SLOT,
    );
  if (invalidDispatchRuntime) throw failedConfiguration();
  const sideEffect = repeatable
    ? HTTP_SIDE_EFFECT_CLASS.safe
    : HTTP_SIDE_EFFECT_CLASS.unsafe;
  return {
    config,
    input,
    runtime,
    connections,
    connectionId,
    repeatable,
    sideEffect,
    invocation,
  };
}

export async function prepareRequestBody({
  config,
  input,
  runtime,
  invocation,
}: RequestContext) {
  let body: Uint8Array | NodeVerifiedByteSource | undefined;
  let multipartContentType: string | undefined;
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
      body = await readRequestBody(input, config.method, {
        artifacts: runtime.artifacts,
        signal: invocation.signal,
        failure: failedConfiguration,
      });
    }
  } catch (error) {
    if (runtime.providerDispatchUnresolved ?? false)
      throw new HttpRequestExecutorError(
        Object.freeze({ kind: 'outcome_unknown', errorKind: 'provider' }),
        { possiblyDispatched: true },
      );
    throw error;
  }

  return { body, multipartContentType };
}

export async function resolveRequestConnection(
  context: RequestContext,
  body: PreparedBody['body'],
  dispatch: DispatchState,
) {
  const { connections, connectionId, invocation, repeatable } = context;
  if (
    connectionId === undefined ||
    connections?.resolveHttpCredential === undefined
  )
    return undefined;
  try {
    return await connections.resolveHttpCredential({
      connectionId,
      purpose: 'http.request.execute',
      signal: invocation.signal,
    });
  } catch (error: unknown) {
    await releaseHttpMaterial(body, undefined, {
      repeatable,
      possiblyDispatched: dispatch.possiblyDispatched,
    });
    throw credentialFailure(error, context);
  }
}

/** Why a step has no credential, for the first request or a renewal partway through. */
export function credentialFailure(
  error: unknown,
  { invocation, runtime, repeatable }: RequestContext,
): NodeExecutorFailure {
  if (!repeatable && (runtime.providerDispatchUnresolved ?? false))
    return new HttpRequestExecutorError(
      Object.freeze({ kind: 'outcome_unknown', errorKind: 'provider' }),
      { possiblyDispatched: true },
    );
  if (safeInstanceOf(error, OAuth2TokenFailure))
    return new HttpOAuth2Failure(error);
  if (safeInstanceOf(error, ProviderExecutionRateLimitError))
    return new HttpRequestExecutorError(
      Object.freeze({
        kind: 'retry',
        errorKind: 'rate_limit',
        reuseProviderKey: false,
      }),
      { possiblyDispatched: false },
    );
  if (safeInstanceOf(error, ProviderCredentialInvalidError))
    return new HttpRequestExecutorError(
      Object.freeze({ kind: 'failed', errorKind: 'authentication' }),
      { possiblyDispatched: false },
    );
  if (invocation.signal.aborted || errorNameIs(error, 'AbortError'))
    return new HttpRequestExecutorError(
      Object.freeze({ kind: 'canceled', errorKind: 'canceled' }),
      { possiblyDispatched: false },
    );
  return new HttpRequestExecutorError(
    Object.freeze({
      kind: 'retry',
      errorKind: 'provider',
      reuseProviderKey: false,
    }),
    { possiblyDispatched: false },
  );
}
