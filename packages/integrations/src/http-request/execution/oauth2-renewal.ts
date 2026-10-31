import type {
  SecureHttpBodyConsumer,
  SecureHttpClient,
  SecureHttpRequest,
  SecureHttpResponse,
} from '../../http/secure.js';
import { OAuth2TokenFailure } from '../../oauth2/contract.js';

export type OAuth2RenewalCredential = Readonly<{
  accessToken: string;
  tokenVersionId: string;
  requestHosts:
    | Readonly<{ mode: 'any' }>
    | Readonly<{ mode: 'listed'; hosts: readonly string[] }>;
}>;

type Dependencies = Readonly<{
  client: Pick<SecureHttpClient, 'executeStreaming'>;
  credential: OAuth2RenewalCredential;
  reject(tokenVersionId: string): Promise<boolean>;
  renew(): Promise<OAuth2RenewalCredential>;
}>;

const REPEAT = Symbol('repeat');

const isRepeat = (body: unknown): body is typeof REPEAT => body === REPEAT;

/** RFC 9110: only these can't have caused a side effect, so only these may repeat. */
const mayRepeat = (method: SecureHttpRequest['method']): boolean =>
  method === 'GET' || method === 'HEAD';

/** `*.example.com` covers its subdomains, not example.com itself. */
export function isOAuth2HostAllowed(
  requestHosts: OAuth2RenewalCredential['requestHosts'],
  url: string,
): boolean {
  if (requestHosts.mode === 'any') return true;
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/u, '');
  return requestHosts.hosts.some((entry) =>
    entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry,
  );
}

function assertHostAllowed(
  { requestHosts }: OAuth2RenewalCredential,
  url: string,
): void {
  if (!isOAuth2HostAllowed(requestHosts, url))
    throw new OAuth2TokenFailure('http.oauth2_host_not_allowed');
}

/**
 * Sends each request with the connection's current token, only to a host it
 * allows. A 401 on a read renews once and repeats; on anything else it only asks
 * the next attempt to renew, because nothing proves a 401 means nothing happened.
 */
export function createOAuth2RenewalClient({
  client,
  credential,
  reject,
  renew,
}: Dependencies): Pick<SecureHttpClient, 'executeStreaming'> {
  let current = credential;
  // One renewal per 2xx, so an endpoint that always answers 401 can't drive refreshes.
  let mayRenew = true;

  const send = <Body>(
    request: SecureHttpRequest,
    consume: SecureHttpBodyConsumer<Body>,
  ): Promise<SecureHttpResponse<Body | typeof REPEAT>> => {
    const token = current;
    return client.executeStreaming<Body | typeof REPEAT>(
      {
        ...request,
        headers: {
          ...request.headers,
          authorization: `Bearer ${token.accessToken}`,
        },
        sensitiveValues: [
          ...(request.sensitiveValues ?? []),
          `Bearer ${token.accessToken}`,
          token.accessToken,
        ],
      },
      async (stream) => {
        if (stream.status >= 200 && stream.status <= 299) mayRenew = true;
        if (stream.status !== 401) return consume(stream);
        // Failing to mark is the same as not marking: this answer still stands.
        const marked = await reject(token.tokenVersionId).catch(() => false);
        // The body of a refused read is left unread and so is never stored.
        if (marked && mayRepeat(request.method) && mayRenew) return REPEAT;
        return consume(stream);
      },
    );
  };

  return Object.freeze({
    executeStreaming: async <Body>(
      request: SecureHttpRequest,
      consume: SecureHttpBodyConsumer<Body>,
    ): Promise<SecureHttpResponse<Body>> => {
      assertHostAllowed(current, request.url);
      const first = await send(request, consume);
      if (!isRepeat(first.body)) return { ...first, body: first.body };
      mayRenew = false;
      current = await renew();
      assertHostAllowed(current, request.url);
      const second = await send(request, consume);
      if (isRepeat(second.body))
        throw new Error('A renewed request asked to repeat again');
      return { ...second, body: second.body };
    },
  });
}
