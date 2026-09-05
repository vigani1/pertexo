import {
  type NodeConnectionRuntime,
  NodeDispatchEvidenceError,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';

import {
  SECURE_HTTP_ERROR_CODE,
  secureHttpPreDispatchError,
} from './http/secure-http.js';

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
    } catch {
      throw secureHttpPreDispatchError(
        SECURE_HTTP_ERROR_CODE.connectionFenceFailed,
      );
    }
    try {
      await input.runtime.beforeDispatch();
    } catch (error: unknown) {
      throw secureHttpPreDispatchError(
        error instanceof NodeDispatchEvidenceError &&
          error.code === 'provider_dispatch_binding_mismatch'
          ? SECURE_HTTP_ERROR_CODE.dispatchBindingMismatch
          : error instanceof NodeDispatchEvidenceError &&
              error.code === 'provider_connection_fence_failed'
            ? SECURE_HTTP_ERROR_CODE.connectionFenceFailed
            : SECURE_HTTP_ERROR_CODE.dispatchEvidenceFailed,
      );
    }
  };
}
