import {
  type NodeExecutionRuntime,
  NodeExecutorFailure,
} from '@pertexo/node-sdk/server';

import { SECURE_HTTP_ERROR_CODE } from '../http/secure.js';
import { providerFailure } from '../providers/failure.js';
import { inspectSecureHttpError } from '../http/secure-error.js';
import { safeInstanceOf } from '../http/unknown-error.js';
import type { ResendApiResult } from './client.js';

export class EmailSendNotificationExecutorError extends NodeExecutorFailure {
  public override readonly name = 'EmailSendNotificationExecutorError';
}

export const failure = providerFailure(EmailSendNotificationExecutorError);

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

/** What a thrown send means for the attempt, given any earlier unresolved dispatch. */
export function classifySendError(
  error: unknown,
  runtime: NodeExecutionRuntime,
): NodeExecutorFailure {
  const unresolved = runtime.providerDispatchUnresolved ?? false;
  if (safeInstanceOf(error, EmailSendNotificationExecutorError)) return error;
  // Encoding the attachments fails before dispatch with its own problem.
  if (safeInstanceOf(error, NodeExecutorFailure))
    return unresolved
      ? failure('outcome_unknown', 'provider', { possiblyDispatched: true })
      : error;
  const secureError = inspectSecureHttpError(error);
  if (secureError === undefined)
    return unresolved
      ? failure('outcome_unknown', 'provider', { possiblyDispatched: true })
      : failure('retry', 'network', { possiblyDispatched: true });
  if (secureError.code === SECURE_HTTP_ERROR_CODE.dispatchBindingMismatch)
    return dispatchIdentityFailure(runtime, 'configuration');
  if (secureError.code === SECURE_HTTP_ERROR_CODE.connectionFenceFailed)
    return dispatchIdentityFailure(runtime, 'authentication');
  if (secureError.code === SECURE_HTTP_ERROR_CODE.canceled)
    return failure('canceled', 'canceled', {
      possiblyDispatched: secureError.possiblyDispatched,
    });
  if (unresolved)
    return failure('outcome_unknown', 'provider', { possiblyDispatched: true });
  if (secureError.code === SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed)
    return failure('retry', 'provider', { possiblyDispatched: false });
  return failure(
    'retry',
    secureError.code === SECURE_HTTP_ERROR_CODE.timedOut
      ? 'timeout'
      : 'network',
    { possiblyDispatched: secureError.possiblyDispatched },
  );
}
