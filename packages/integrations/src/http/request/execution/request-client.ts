import { HTTP_REQUEST_CREDENTIAL_PURPOSE } from './credentials.js';
import type {
  NodeConnectionRuntime,
  ResolvedHttpCredential,
} from '@pertexo/node-sdk/server';
import type { ProviderHttpClient } from '../../../providers/http-client.js';
import { createOAuth2RenewalClient } from './oauth2-renewal.js';
import { failedConfiguration } from '../request.errors.js';
type RequestCredentialScope = Readonly<{
  connections: NodeConnectionRuntime | undefined;
  connectionId: string | undefined;
  signal: AbortSignal;
  onCredentialError(error: unknown): Error;
}>;

export function requestClient(
  client: Pick<ProviderHttpClient, 'executeStreaming'>,
  scope: RequestCredentialScope,
  resolved: ResolvedHttpCredential | undefined,
) {
  return resolved?.authType === 'oauth2'
    ? oauth2Client(client, scope, resolved)
    : client;
}
/** A token that renews itself and goes only where its connection allows. */
function oauth2Client(
  client: Pick<ProviderHttpClient, 'executeStreaming'>,
  scope: RequestCredentialScope,
  credential: Extract<ResolvedHttpCredential, { authType: 'oauth2' }>,
) {
  const { connections, connectionId, signal, onCredentialError } = scope;
  if (
    connectionId === undefined ||
    connections?.rejectAccessToken === undefined ||
    connections.resolveHttpCredential === undefined
  )
    throw failedConfiguration();
  const { rejectAccessToken, resolveHttpCredential } = connections;
  return createOAuth2RenewalClient({
    client,
    credential,
    reject: (tokenVersionId) =>
      rejectAccessToken({
        connectionId,
        tokenVersionId,
        signal,
      }),
    renew: async () => {
      let renewed;
      try {
        renewed = await resolveHttpCredential({
          connectionId,
          purpose: HTTP_REQUEST_CREDENTIAL_PURPOSE,
          signal,
        });
      } catch (error: unknown) {
        throw onCredentialError(error);
      }
      if (renewed.authType !== 'oauth2') throw failedConfiguration();
      return renewed;
    },
  });
}
