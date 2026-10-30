import type { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import {
  MAXIMUM_RETRY_DELAY_MILLIS,
  type NodeExecutionRuntime,
  type NodeExecutorErrorKind,
  type NodeExecutorFailureKind,
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
} from '@pertexo/node-sdk/server';

import {
  errorNameIs,
  safeInstanceOf,
  safeNumberProperty,
} from '../http/unknown-error.js';

export type ProviderFailure<Failure extends NodeExecutorFailure> = (
  kind: NodeExecutorFailureKind,
  errorKind: NodeExecutorErrorKind,
  options: Readonly<{
    possiblyDispatched: boolean;
    retryAfterMillis?: number | undefined;
  }>,
) => Failure;

/** A provider's failure constructor; a service never stretches a retry wait past the platform maximum. */
export function providerFailure<Failure extends NodeExecutorFailure>(
  Failure: new (outcome: unknown) => Failure,
): ProviderFailure<Failure> {
  return (kind, errorKind, { possiblyDispatched, retryAfterMillis }) =>
    new Failure({
      kind,
      errorKind,
      possiblyDispatched,
      ...(retryAfterMillis === undefined
        ? {}
        : {
            minimumRetryDelayMillis: Math.min(
              retryAfterMillis,
              MAXIMUM_RETRY_DELAY_MILLIS,
            ),
          }),
    });
}

/**
 * What a failed connection lookup means for the attempt. An earlier call
 * that may have reached the service stays uncertain, whatever the lookup's
 * cause, so it is never repeated automatically.
 */
export function connectionLookupFailure<Failure extends NodeExecutorFailure>(
  error: unknown,
  {
    failure,
    runtime,
    signal,
  }: Readonly<{
    failure: ProviderFailure<Failure>;
    runtime: NodeExecutionRuntime;
    signal: AbortSignal;
  }>,
): Failure {
  if (runtime.providerDispatchUnresolved ?? false)
    return failure('outcome_unknown', 'provider', { possiblyDispatched: true });
  if (safeInstanceOf(error, ProviderExecutionRateLimitError)) {
    const retryAfterSeconds = safeNumberProperty(error, 'retryAfterSeconds');
    return retryAfterSeconds === undefined
      ? failure('retry', 'provider', { possiblyDispatched: false })
      : failure('retry', 'rate_limit', {
          possiblyDispatched: false,
          retryAfterMillis: retryAfterSeconds * 1_000,
        });
  }
  if (safeInstanceOf(error, ProviderCredentialInvalidError))
    return failure('failed', 'authentication', { possiblyDispatched: false });
  if (signal.aborted || errorNameIs(error, 'AbortError'))
    return failure('canceled', 'canceled', { possiblyDispatched: false });
  return failure('retry', 'provider', { possiblyDispatched: false });
}
