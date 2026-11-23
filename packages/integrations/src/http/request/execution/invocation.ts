import {
  type NodeVerifiedByteSource,
  type NodeConnectionRuntime,
  type ResolvedNodeConnection,
  type ResolvedHttpCredential,
  type NodeExecutionInvocation,
  type NodeExecutionRuntime,
  FileInputFailure,
  type NodeExecutorFailure,
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
} from '@pertexo/node-sdk/server';
import { HTTP_SIDE_EFFECT_CLASS } from '../../outcome-policy.js';
import { OAuth2TokenFailure } from '../../../oauth2/oauth2.errors.js';

import { errorNameIs, safeInstanceOf } from '@pertexo/node-sdk/server';
import type {
  HttpRequestConfig,
  HttpRequestInput,
} from '../request.schemas.js';

import { encodeMultipart } from '../multipart/encode.js';
import { readRequestBody } from '../read-body.js';
import { failedConfiguration } from '../request.errors.js';
import { HttpRequestExecutorError } from '../request.errors.js';
import { releaseHttpMaterial } from './body.js';
import { HttpOAuth2Failure } from './oauth2-renewal.errors.js';

export type RequestContext = ReturnType<typeof prepareInvocation>;

interface DispatchState {
  possiblyDispatched: boolean;
}

type PreparedBody = Awaited<ReturnType<typeof prepareRequestBody>>;

export type RequestMaterial = PreparedBody &
  Readonly<{
    resolved: Awaited<ReturnType<typeof resolveRequestConnection>>;
    dispatch: DispatchState;
    // Opened by withProviderCredential when the connection carries header credentials.
    credential?: RequestCredentialMaterial;
    credentialTest: boolean;
  }>;

export type ResolvedRequestCredential =
  ResolvedNodeConnection | ResolvedHttpCredential;

export type RequestCredentialMaterial = Readonly<{
  headers: Readonly<Record<string, string>>;
  sensitiveValues?: readonly string[];
}>;

export interface RequestConnectionBinding {
  readonly slot: string;
  readonly providerKey: string;
  resolve(
    connections: NodeConnectionRuntime,
    input: Readonly<{ connectionId: string; signal: AbortSignal }>,
  ): Promise<ResolvedRequestCredential>;
  withHeaders<T>(
    resolved: ResolvedRequestCredential,
    connectionId: string,
    run: (material: RequestCredentialMaterial) => Promise<T>,
  ): Promise<T>;
}

type HttpInvocation = Pick<
  NodeExecutionInvocation<unknown, unknown>,
  'signal' | 'connectionRefs'
> &
  Readonly<{
    runtime?: Pick<
      NodeExecutionRuntime,
      | 'sideEffectClass'
      | 'connections'
      | 'providerIdempotencyKey'
      | 'providerDispatchUnresolved'
      | 'artifacts'
      | 'callbacks'
      | 'deadlineAt'
      | 'beforeDispatch'
    >;
  }>;

export function prepareInvocation(
  invocation: HttpInvocation,
  config: HttpRequestConfig,
  input: HttpRequestInput,
  binding: RequestConnectionBinding | undefined,
  approvedOrigin?: string,
) {
  if (
    approvedOrigin !== undefined &&
    (new URL(config.url).origin !== approvedOrigin || config.maxRedirects !== 0)
  )
    throw failedConfiguration();
  const runtime = invocation.runtime;
  if (runtime === undefined) throw failedConfiguration();
  const connections = runtime.connections;
  const connectionId =
    binding === undefined ? undefined : invocation.connectionRefs[binding.slot];
  // GET and HEAD only read (RFC 9110 §9.2.1), so a repeat can't cause a side
  // effect: their failures retry and can follow a failure link instead of
  // leaving the outcome unknown.
  const repeatable = config.method === 'GET' || config.method === 'HEAD';
  // An attempt planned before classes came from the method still says unsafe.
  const sideEffect = repeatable
    ? HTTP_SIDE_EFFECT_CLASS.safe
    : HTTP_SIDE_EFFECT_CLASS.unsafe;
  const expectedClass =
    runtime.sideEffectClass === sideEffect ||
    (approvedOrigin === undefined && runtime.sideEffectClass === 'unsafe');
  const invalidDispatchRuntime =
    (approvedOrigin !== undefined &&
      binding !== undefined &&
      connectionId === undefined) ||
    (connectionId !== undefined && connections?.assertCurrent === undefined) ||
    !expectedClass ||
    runtime.providerIdempotencyKey !== undefined ||
    Object.keys(invocation.connectionRefs).some(
      (slot) => slot !== binding?.slot,
    );
  if (invalidDispatchRuntime) throw failedConfiguration();
  return {
    config,
    input,
    runtime,
    connections,
    connectionId,
    binding,
    approvedOrigin,
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
): Promise<ResolvedRequestCredential | undefined> {
  const { binding, connections, connectionId, invocation, repeatable } =
    context;
  if (
    binding === undefined ||
    connectionId === undefined ||
    connections === undefined
  )
    return undefined;
  try {
    return await binding.resolve(connections, {
      connectionId,
      signal: invocation.signal,
    });
  } catch (error: unknown) {
    await releaseHttpMaterial(body, {
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
