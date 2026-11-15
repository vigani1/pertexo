import type { ResolvedHttpCredential } from '@pertexo/node-sdk/server';
import type { HttpRequestExecutorDependencies } from '../request.executor.js';
import { createOAuth2RenewalClient } from './oauth2-renewal.js';
import { failedConfiguration } from '../request.errors.js';
import { type RequestContext, credentialFailure } from './invocation.js';

export function requestClient(
  dependencies: HttpRequestExecutorDependencies,
  context: RequestContext,
  resolved: ResolvedHttpCredential | undefined,
) {
  return resolved?.authType === 'oauth2'
    ? oauth2Client(dependencies, context, resolved)
    : dependencies.httpClient;
}
/** A token that renews itself and goes only where its connection allows. */
function oauth2Client(
  dependencies: HttpRequestExecutorDependencies,
  context: RequestContext,
  credential: Extract<ResolvedHttpCredential, { authType: 'oauth2' }>,
) {
  const { connections, connectionId, invocation } = context;
  if (
    connectionId === undefined ||
    connections?.rejectAccessToken === undefined ||
    connections.resolveHttpCredential === undefined
  )
    throw failedConfiguration();
  const { rejectAccessToken, resolveHttpCredential } = connections;
  return createOAuth2RenewalClient({
    client: dependencies.httpClient,
    credential,
    reject: (tokenVersionId) =>
      rejectAccessToken({
        connectionId,
        tokenVersionId,
        signal: invocation.signal,
      }),
    renew: async () => {
      let renewed;
      try {
        renewed = await resolveHttpCredential({
          connectionId,
          purpose: 'http.request.execute',
          signal: invocation.signal,
        });
      } catch (error: unknown) {
        throw credentialFailure(error, context);
      }
      if (renewed.authType !== 'oauth2') throw failedConfiguration();
      return renewed;
    },
  });
}
