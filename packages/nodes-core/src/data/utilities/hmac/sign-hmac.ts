import { createHmac } from 'node:crypto';
import { signingKeyCredentialSchema } from '@pertexo/node-sdk';
import {
  NodeExecutorFailure,
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
  type NodeExecutionInvocation,
  withProviderCredential,
} from '@pertexo/node-sdk/server';
import { refuseUtility, UTILITY_ERROR_CODE } from '../utility-result.js';
import type { HmacConfig } from './hmac.schemas.js';

export async function signHmac(
  invocation: NodeExecutionInvocation<unknown, unknown>,
) {
  const connections = invocation.runtime?.connections;
  const connectionId = invocation.connectionRefs.hmac_key;
  if (connections?.assertCurrent === undefined || connectionId === undefined)
    return refuseUtility(
      'hmac_connection',
      'Choose a Signing key connection for this step.',
    );
  const { assertCurrent } = connections;
  let resolved;
  try {
    resolved = await connections.resolve({
      connectionId,
      expectedProviderKey: 'signing',
      expectedAuthType: 'hmac_key',
      purpose: 'core.hmac.execute',
      signal: invocation.signal,
    });
  } catch (error) {
    return keyUnavailable(error, invocation.signal);
  }
  try {
    return await withProviderCredential(
      resolved,
      {
        connectionId,
        providerKey: 'signing',
        authTypes: ['hmac_key'],
        schema: signingKeyCredentialSchema,
        refuse: () => new ProviderCredentialInvalidError(),
      },
      async (credential) => {
        const key = new TextEncoder().encode(credential.signingKey);
        try {
          try {
            await assertCurrent({
              connectionId,
              expectedProviderKey: 'signing',
              expectedAuthType: 'hmac_key',
              secretVersionId: resolved.secretVersionId,
              signal: invocation.signal,
            });
          } catch (error) {
            return keyUnavailable(error, invocation.signal);
          }
          invocation.signal.throwIfAborted();
          const config = invocation.config as HmacConfig;
          return {
            value: createHmac(config.algorithm, key)
              .update((invocation.input as { value: string }).value, 'utf8')
              .digest(config.encoding),
          };
        } finally {
          key.fill(0);
        }
      },
    );
  } catch (error) {
    if (error instanceof ProviderCredentialInvalidError)
      return keyUnavailable(error, invocation.signal);
    throw error;
  }
}

/** The connection or its key can't be read now: refuse a bad one, retry a transient failure. */
function keyUnavailable(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw error;
  if (error instanceof ProviderCredentialInvalidError)
    return refuseUtility(
      'hmac_connection',
      'The Signing key connection is unavailable. Reconnect it before trying again.',
    );
  throw new NodeExecutorFailure({
    kind: 'retry',
    errorKind:
      error instanceof ProviderExecutionRateLimitError
        ? 'rate_limit'
        : 'network',
    possiblyDispatched: false,
    ...(error instanceof ProviderExecutionRateLimitError
      ? { minimumRetryDelayMillis: error.retryAfterSeconds * 1000 }
      : {}),
    safeErrorCode: UTILITY_ERROR_CODE.hmac_unavailable,
    errorSummary: 'The signing key could not be read. Try again shortly.',
  });
}
