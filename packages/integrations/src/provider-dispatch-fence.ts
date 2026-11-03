import { createHash } from 'node:crypto';

import {
  type NodeConnectionRuntime,
  NodeDispatchEvidenceError,
  type NodeExecutionRuntime,
  ProviderCredentialInvalidError,
} from '@pertexo/node-sdk/server';

import {
  PROVIDER_HTTP_ERROR_CODE,
  ProviderHttpError,
  providerHttpPreDispatchError,
} from './providers/http.errors.js';
import {
  errorCodeIs,
  errorNameIs,
  safeInstanceOf,
} from '@pertexo/node-sdk/server';

function dispatchEvidenceErrorCode(
  error: unknown,
):
  | typeof PROVIDER_HTTP_ERROR_CODE.connectionFenceFailed
  | typeof PROVIDER_HTTP_ERROR_CODE.dispatchBindingMismatch
  | typeof PROVIDER_HTTP_ERROR_CODE.dispatchEvidenceFailed {
  if (!safeInstanceOf(error, NodeDispatchEvidenceError))
    return PROVIDER_HTTP_ERROR_CODE.dispatchEvidenceFailed;
  if (errorCodeIs(error, 'provider_dispatch_binding_mismatch'))
    return PROVIDER_HTTP_ERROR_CODE.dispatchBindingMismatch;
  if (errorCodeIs(error, 'provider_connection_fence_failed'))
    return PROVIDER_HTTP_ERROR_CODE.connectionFenceFailed;
  return PROVIDER_HTTP_ERROR_CODE.dispatchEvidenceFailed;
}

export function createProviderBeforeDispatch(input: {
  readonly assertCurrent: NonNullable<NodeConnectionRuntime['assertCurrent']>;
  readonly connectionId: string;
  readonly expectedAuthType: string;
  readonly expectedProviderKey: string;
  readonly runtime: NodeExecutionRuntime;
  readonly secretVersionId: string;
  readonly signal: AbortSignal;
}): () => Promise<void> {
  return async () => {
    try {
      await input.assertCurrent({
        connectionId: input.connectionId,
        expectedProviderKey: input.expectedProviderKey,
        expectedAuthType: input.expectedAuthType,
        secretVersionId: input.secretVersionId,
        signal: input.signal,
      });
    } catch (error: unknown) {
      if (safeInstanceOf(error, ProviderCredentialInvalidError))
        throw providerHttpPreDispatchError(
          PROVIDER_HTTP_ERROR_CODE.connectionFenceFailed,
        );
      if (input.signal.aborted || errorNameIs(error, 'AbortError'))
        throw new ProviderHttpError(
          PROVIDER_HTTP_ERROR_CODE.canceled,
          'definite_failure',
          { possiblyDispatched: false },
        );
      throw providerHttpPreDispatchError(
        PROVIDER_HTTP_ERROR_CODE.dispatchEvidenceFailed,
      );
    }
    try {
      await input.runtime.beforeDispatch({
        connectionFence: {
          connectionId: input.connectionId,
          expectedProviderKey: input.expectedProviderKey,
          expectedAuthType: input.expectedAuthType,
          secretVersionId: input.secretVersionId,
        },
        providerDispatchBinding: `${input.expectedProviderKey}:sha256:${createHash(
          'sha256',
        )
          .update(
            `${input.expectedProviderKey}\0${input.connectionId}\0${input.secretVersionId}`,
          )
          .digest('hex')}`,
      });
    } catch (error: unknown) {
      throw providerHttpPreDispatchError(dispatchEvidenceErrorCode(error));
    }
  };
}

/** Dispatch evidence for a request that carries no connection, such as a public API call. */
export function createUnauthenticatedBeforeDispatch(
  runtime: NodeExecutionRuntime,
): () => Promise<void> {
  return async () => {
    try {
      await runtime.beforeDispatch();
    } catch (error: unknown) {
      throw providerHttpPreDispatchError(dispatchEvidenceErrorCode(error));
    }
  };
}
