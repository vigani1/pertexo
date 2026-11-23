import { executeHttpRequest } from '../http/request/lifecycle.js';
import { prepareInvocation } from '../http/request/execution/invocation.js';
import { HTTP_REQUEST_LIMITS } from '../http/request/request.schemas.js';
import { failedConfiguration } from '../http/request/request.errors.js';
import type { ProviderHttpClient } from '../providers/http-client.js';
import type { ConnectionDefinition } from '../providers/connection-definition.js';
import { recipeConnection } from './recipe-connection.js';

export async function executeCommunityConnectionTest(
  client: Pick<ProviderHttpClient, 'executeStreaming' | 'redactText'>,
  definition: ConnectionDefinition,
  input: Readonly<{
    providerKey: string;
    connectionId: string;
    secretVersionId: string;
    signal: AbortSignal;
    timeoutMillis: number;
    open(): Promise<Uint8Array>;
    beforeDispatch(): Promise<void>;
  }>,
): Promise<number> {
  const { test, auth, authType } = definition;
  if (
    test.kind !== 'http' ||
    test.approvedOrigin === undefined ||
    typeof test.target !== 'string' ||
    (test.method !== 'GET' && test.method !== 'HEAD') ||
    !('kind' in auth) ||
    (auth.kind !== 'named_header' &&
      auth.kind !== 'bearer' &&
      auth.kind !== 'basic')
  )
    throw failedConfiguration();

  const context = prepareInvocation(
    {
      signal: input.signal,
      connectionRefs: {},
      runtime: {
        sideEffectClass: 'safe',
        beforeDispatch: input.beforeDispatch,
      },
    },
    {
      url: test.target,
      method: test.method,
      headers: {},
      timeoutMillis: input.timeoutMillis,
      maxRedirects: 0,
      maxResponseBytes: HTTP_REQUEST_LIMITS.defaultInlineResponseBytes,
      inlineResponseBytes: HTTP_REQUEST_LIMITS.defaultInlineResponseBytes,
      returnErrorResponses: true,
    },
    {},
    undefined,
    test.approvedOrigin,
  );

  const binding = recipeConnection(input.providerKey, definition, auth);
  const { connectionId, providerKey, secretVersionId } = input;
  const response = await executeHttpRequest(client, context, async (run) =>
    binding.withHeaders(
      {
        connectionId,
        providerKey,
        authType,
        secretVersionId,
        secret: await input.open(),
      },
      connectionId,
      run,
    ),
  );
  return response.status;
}
