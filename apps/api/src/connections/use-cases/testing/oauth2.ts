import type {
  ConnectionRecord,
  ConnectionTestOutcome,
} from '@pertexo/core/connections';
import {
  createOAuth2RenewalClient,
  decodeClientSettings,
  isOAuth2HostAllowed,
  OAuth2TokenFailure,
  type OAuth2GrantLossActor,
} from '@pertexo/integrations/server';

import type { ConnectionOAuth2Dependencies } from '../../ports.js';
import {
  oauth2ApiResponseOutcome,
  oauth2NotActiveOutcome,
  oauth2TokenFailureOutcome,
} from './outcomes.js';

/** Who the connection's record names if this test finds the grant lost. */
export function oauth2TestActor(
  input: Readonly<{
    actor: Readonly<{ actorId: string }>;
    requestId?: string;
    traceId?: string;
  }>,
): OAuth2GrantLossActor {
  return {
    source: 'test',
    actorId: input.actor.actorId,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
  };
}

/** Gets a token as a step would, and asks the URL once, renewing once on a 401. */
export async function testOAuth2Connection(
  { tokens, apiClient }: ConnectionOAuth2Dependencies,
  input: Readonly<{
    workspaceId: string;
    actor: OAuth2GrantLossActor;
    connection: ConnectionRecord;
    url: string;
    timeoutMillis: number;
    maxRedirects: number;
    maxResponseBytes: number;
    signal: AbortSignal;
    beforeDispatch: () => Promise<void>;
  }>,
): Promise<ConnectionTestOutcome> {
  const { connection, url, signal } = input;
  if (connection.status !== 'active' || connection.oauth2 === undefined)
    return oauth2NotActiveOutcome(connection.lastErrorCode);
  const { requestHosts } = decodeClientSettings(connection.oauth2.settings);
  if (!isOAuth2HostAllowed(requestHosts, url))
    return oauth2TokenFailureOutcome('http.oauth2_host_not_allowed');
  const scope = {
    workspaceId: input.workspaceId,
    connectionId: connection.id,
    loss: input.actor,
  };
  let dispatched = false;
  try {
    const client = createOAuth2RenewalClient({
      client: apiClient,
      credential: await tokens.accessToken(scope, signal),
      reject: (tokenVersionId) =>
        tokens.rejectToken(scope, tokenVersionId, signal),
      renew: () => tokens.accessToken(scope, signal),
    });
    const response = await client.executeStreaming(
      {
        url,
        method: 'GET',
        timeoutMillis: input.timeoutMillis,
        maxRedirects: input.maxRedirects,
        maxResponseBytes: input.maxResponseBytes,
        signal,
        // A repeat after a 401 is the same test, so its evidence is written once.
        beforeDispatch: async () => {
          if (dispatched) return;
          await input.beforeDispatch();
          dispatched = true;
        },
      },
      async (stream) => {
        for await (const chunk of stream.body) new Uint8Array(chunk).fill(0);
      },
    );
    return oauth2ApiResponseOutcome(response.status);
  } catch (error: unknown) {
    if (!(error instanceof OAuth2TokenFailure)) throw error;
    return error.code === 'http.oauth2_not_connected'
      ? oauth2NotActiveOutcome(connection.lastErrorCode)
      : oauth2TokenFailureOutcome(error.code);
  }
}
