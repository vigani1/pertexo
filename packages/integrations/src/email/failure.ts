import {
  type NodeExecutionRuntime,
  NodeExecutorFailure,
} from '@pertexo/node-sdk/server';

import type { ResendApiResult } from './client.js';

export class EmailSendNotificationExecutorError extends NodeExecutorFailure {
  public override readonly name = 'EmailSendNotificationExecutorError';
}

export function failure(
  kind: 'failed' | 'canceled' | 'retry' | 'outcome_unknown',
  errorKind:
    | 'authentication'
    | 'canceled'
    | 'configuration'
    | 'internal'
    | 'network'
    | 'provider'
    | 'rate_limit'
    | 'timeout',
  {
    possiblyDispatched,
    retryAfterMillis,
  }: Readonly<{
    possiblyDispatched: boolean;
    retryAfterMillis?: number | undefined;
  }>,
) {
  return new EmailSendNotificationExecutorError({
    kind,
    errorKind,
    possiblyDispatched,
    ...(retryAfterMillis === undefined
      ? {}
      : { minimumRetryDelayMillis: Math.min(retryAfterMillis, 60_000) }),
  });
}

export function credentialFailure(runtime: NodeExecutionRuntime | undefined) {
  return !(runtime?.providerDispatchUnresolved ?? false)
    ? failure('failed', 'authentication', { possiblyDispatched: false })
    : failure('outcome_unknown', 'authentication', {
        possiblyDispatched: true,
      });
}

export function dispatchIdentityFailure(
  runtime: NodeExecutionRuntime | undefined,
  errorKind: 'authentication' | 'configuration',
) {
  return !(runtime?.providerDispatchUnresolved ?? false)
    ? failure('failed', errorKind, { possiblyDispatched: false })
    : failure('outcome_unknown', errorKind, { possiblyDispatched: true });
}

export function classifyResult(
  result: Exclude<ResendApiResult, { kind: 'succeeded' }>,
  runtime: NodeExecutionRuntime,
): never {
  if (runtime.providerDispatchUnresolved ?? false)
    throw failure('outcome_unknown', 'provider', { possiblyDispatched: true });
  switch (result.kind) {
    case 'rate_limited':
      throw failure('retry', 'rate_limit', {
        possiblyDispatched: false,
        retryAfterMillis: result.retryAfterMillis,
      });
    case 'http_failure':
      if (result.status === 401 || result.status === 403)
        throw failure('failed', 'authentication', {
          possiblyDispatched: false,
        });
      if (result.status === 400 || result.status === 422)
        throw failure('failed', 'provider', { possiblyDispatched: false });
      throw failure('retry', 'provider', { possiblyDispatched: true });
    case 'invalid_response':
      throw failure('retry', 'provider', { possiblyDispatched: true });
    case 'rejected':
      if (result.status === 401 || result.status === 403)
        throw failure('failed', 'authentication', {
          possiblyDispatched: false,
        });
      if (result.status === 400 || result.status === 422)
        throw failure('failed', 'provider', { possiblyDispatched: false });
      if (result.error === 'invalid_idempotent_request')
        throw failure('failed', 'provider', { possiblyDispatched: false });
      throw failure('retry', 'provider', { possiblyDispatched: true });
  }
}
