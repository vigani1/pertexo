import { createHmac } from 'node:crypto';
import { signingKeyCredentialSchema } from '@pertexo/node-sdk';
import {
  NodeExecutorFailure,
  ProviderCredentialInvalidError,
  ProviderExecutionRateLimitError,
  type NodeExecutionInvocation,
} from '@pertexo/node-sdk/server';
import { refuseUtility } from '../result.js';
import type { HmacConfig } from './validation.js';

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
  let resolved;
  let key: Uint8Array | undefined;
  try {
    try {
      resolved = await connections.resolve({
        connectionId,
        expectedProviderKey: 'signing',
        expectedAuthType: 'hmac_key',
        purpose: 'core.hmac.execute',
        signal: invocation.signal,
      });
      if (
        resolved.connectionId !== connectionId ||
        resolved.providerKey !== 'signing' ||
        resolved.authType !== 'hmac_key'
      )
        throw new ProviderCredentialInvalidError();
      let credential;
      try {
        const value: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(resolved.secret),
        );
        credential = signingKeyCredentialSchema.parse(value);
      } catch {
        throw new ProviderCredentialInvalidError();
      }
      key = new TextEncoder().encode(credential.signingKey);
      await connections.assertCurrent({
        connectionId,
        expectedProviderKey: 'signing',
        expectedAuthType: 'hmac_key',
        secretVersionId: resolved.secretVersionId,
        signal: invocation.signal,
      });
    } catch (error) {
      if (invocation.signal.aborted) throw error;
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
        safeErrorCode: 'utility.hmac_unavailable',
        errorSummary: 'The signing key could not be read. Try again shortly.',
      });
    }
    invocation.signal.throwIfAborted();
    const config = invocation.config as HmacConfig;
    return {
      value: createHmac(config.algorithm, key)
        .update((invocation.input as { value: string }).value, 'utf8')
        .digest(config.encoding),
    };
  } finally {
    key?.fill(0);
    resolved?.secret.fill(0);
  }
}
