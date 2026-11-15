import type { ResolvedNodeConnection } from '@pertexo/node-sdk/server';
import { describe, expect, it, vi } from 'vitest';

import {
  createHttpRequestExecutorRegistration,
  HttpRequestExecutorError,
  type ProviderHttpRequest,
  type ProviderHttpResponse,
} from '../../../../src/server.js';
import {
  connectionId,
  credentialBytes,
  encoder,
  invocation,
  response,
  runtime,
  secretVersionId,
  streamingHttpClient,
} from '../../../support/http-execution.js';

const zeroed = (secret: Uint8Array) => secret.every((byte) => byte === 0);

function connectionResolving(resolved: ResolvedNodeConnection) {
  return runtime({
    connections: {
      assertCurrent: () => Promise.resolve(),
      resolve: () => Promise.resolve(resolved),
    },
  });
}

describe('the HTTP step opening its header credential', () => {
  it('sends the credential headers, then zeroes the secret', async () => {
    const state = runtime();
    let sent: ProviderHttpRequest | undefined;
    await createHttpRequestExecutorRegistration({
      httpClient: streamingHttpClient(async (request) => {
        sent = request;
        await request.beforeDispatch();
        return response(encoder.encode('{}'));
      }),
    }).execute(invocation(state.value));
    expect(sent?.headers).toMatchObject({
      authorization: 'Bearer executor-secret',
    });
    expect(zeroed(state.secret)).toBe(true);
  });

  it('refuses a connection of another auth type as configuration, before dispatch, and zeroes its secret', async () => {
    const secret = credentialBytes();
    const state = connectionResolving({
      connectionId,
      providerKey: 'http',
      authType: 'smtp',
      secretVersionId,
      secret,
    });
    const dispatch =
      vi.fn<(request: ProviderHttpRequest) => Promise<ProviderHttpResponse>>();
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(dispatch),
      }).execute(invocation(state.value)),
    ).rejects.toEqual(
      new HttpRequestExecutorError(
        Object.freeze({ kind: 'failed', errorKind: 'configuration' }),
        { possiblyDispatched: false },
      ),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(zeroed(secret)).toBe(true);
  });

  it('refuses an unreadable secret as authentication and zeroes it', async () => {
    const secret = encoder.encode('not json');
    const state = connectionResolving({
      connectionId,
      providerKey: 'http',
      authType: 'http_headers',
      secretVersionId,
      secret,
    });
    await expect(
      createHttpRequestExecutorRegistration({
        httpClient: streamingHttpClient(vi.fn()),
      }).execute(invocation(state.value)),
    ).rejects.toEqual(
      new HttpRequestExecutorError(
        Object.freeze({ kind: 'failed', errorKind: 'authentication' }),
        { possiblyDispatched: false },
      ),
    );
    expect(zeroed(secret)).toBe(true);
  });
});
