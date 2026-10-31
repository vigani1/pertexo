import { describe, expect, it, vi } from 'vitest';

import { createOAuth2RenewalClient } from '../../src/http-request/execution/oauth2-renewal.js';
import type {
  SecureHttpBodyConsumer,
  SecureHttpRequest,
  SecureHttpResponse,
  SecureHttpStreamingBody,
} from '../../src/http/secure.js';

/** A service that answers each request with the next status, recording what it was sent. */
function service(statuses: readonly number[]) {
  const sent: SecureHttpRequest[] = [];
  let next = 0;
  return {
    sent,
    client: {
      executeStreaming: async <Body>(
        request: SecureHttpRequest,
        consume: SecureHttpBodyConsumer<Body>,
      ): Promise<SecureHttpResponse<Body>> => {
        sent.push(request);
        const status = statuses[next] ?? 200;
        next += 1;
        const stream = {
          status,
          headers: {},
          body: (async function* () {
            yield new Uint8Array();
          })(),
          bodyEncoding: 'utf8',
          finalUrl: 'https://api.example.com',
          redirectCount: 0,
          signal: new AbortController().signal,
        } satisfies SecureHttpStreamingBody;
        return {
          status,
          headers: {},
          body: await consume(stream),
          bodyEncoding: 'utf8',
          finalUrl: 'https://api.example.com',
          redirectCount: 0,
        };
      },
    },
  };
}

const credential = (accessToken: string) => ({
  accessToken,
  tokenVersionId: `version-of-${accessToken}`,
  requestHosts: { mode: 'any' } as const,
});

const request = (method: SecureHttpRequest['method'], page = 1) =>
  ({
    url: `https://api.example.com/items?page=${String(page)}`,
    method,
    timeoutMillis: 1_000,
    maxRedirects: 0,
    maxResponseBytes: 1_024,
    beforeDispatch: () => Promise.resolve(),
  }) satisfies SecureHttpRequest;

const statusOf = (stream: SecureHttpStreamingBody) =>
  Promise.resolve(stream.status);

function client(statuses: readonly number[], marks = true) {
  const api = service(statuses);
  const reject = vi.fn(() => Promise.resolve(marks));
  let renewals = 0;
  const renew = vi.fn(() => {
    renewals += 1;
    return Promise.resolve(credential(`renewed-${String(renewals)}`));
  });
  return {
    api,
    reject,
    renew,
    renewal: createOAuth2RenewalClient({
      client: api.client,
      credential: credential('first'),
      reject,
      renew,
    }),
  };
}

const authorizationOf = (sent: SecureHttpRequest) =>
  sent.headers?.authorization;

describe('an OAuth2 request refused with a 401', () => {
  // L11: a read renews once, repeats with the new token, and shows only the second answer.
  it.each(['GET', 'HEAD'] as const)('%s repeats once', async (method) => {
    const { api, renewal } = client([401, 200]);
    const answer = await renewal.executeStreaming(request(method), statusOf);
    expect(answer.body).toBe(200);
    expect(api.sent.map(authorizationOf)).toEqual([
      'Bearer first',
      'Bearer renewed-1',
    ]);
  });

  // L12: nothing else is ever sent twice, whatever the answer.
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    '%s is sent once and still marks the token',
    async (method) => {
      const { api, reject, renew, renewal } = client([401, 200]);
      const answer = await renewal.executeStreaming(request(method), statusOf);
      expect(answer.body).toBe(401);
      expect(api.sent).toHaveLength(1);
      expect(reject).toHaveBeenCalledWith('version-of-first');
      expect(renew).not.toHaveBeenCalled();
    },
  );

  // L13: when marking did nothing, the read fails without repeating.
  it('a read that could not mark the token does not repeat', async () => {
    const { api, renew, renewal } = client([401, 200], false);
    const answer = await renewal.executeStreaming(request('GET'), statusOf);
    expect(answer.body).toBe(401);
    expect(api.sent).toHaveLength(1);
    expect(renew).not.toHaveBeenCalled();
  });

  // Failing to mark is the same as not marking: the 401 itself stands.
  it('a failure to mark leaves the answer as it was', async () => {
    const api = service([401]);
    const renewal = createOAuth2RenewalClient({
      client: api.client,
      credential: credential('first'),
      reject: () => Promise.reject(new Error('database away')),
      renew: () => Promise.reject(new Error('must not renew')),
    });
    const answer = await renewal.executeStreaming(request('GET'), statusOf);
    expect(answer.body).toBe(401);
  });

  // L14: a second 401 after a repeat fails.
  it('a second 401 after a repeat is the answer', async () => {
    const { api, renew, renewal } = client([401, 401]);
    const answer = await renewal.executeStreaming(request('GET'), statusOf);
    expect(answer.body).toBe(401);
    expect(api.sent).toHaveLength(2);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  // L14: a later page may renew again, but only after a 2xx since the last renewal.
  it('a later page renews again only after a 2xx', async () => {
    const { api, renew, renewal } = client([401, 200, 401, 200, 401, 401]);
    const answers = [
      await renewal.executeStreaming(request('GET', 1), statusOf),
      await renewal.executeStreaming(request('GET', 2), statusOf),
    ];
    expect(answers.map(({ body }) => body)).toEqual([200, 200]);
    expect(renew).toHaveBeenCalledTimes(2);
    const third = await renewal.executeStreaming(request('GET', 3), statusOf);
    expect(third.body).toBe(401);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(api.sent).toHaveLength(6);
  });

  it('a 403 neither marks nor renews', async () => {
    const { api, reject, renew, renewal } = client([403]);
    const answer = await renewal.executeStreaming(request('GET'), statusOf);
    expect(answer.body).toBe(403);
    expect(api.sent).toHaveLength(1);
    expect(reject).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
  });
});

describe('where an OAuth2 token may go', () => {
  const listed = (hosts: readonly string[]) => {
    const api = service([200]);
    return {
      api,
      renewal: createOAuth2RenewalClient({
        client: api.client,
        credential: {
          ...credential('first'),
          requestHosts: { mode: 'listed', hosts },
        },
        reject: () => Promise.resolve(false),
        renew: () => Promise.reject(new Error('must not renew')),
      }),
    };
  };

  // S24: nothing is sent to a host the connection doesn't allow.
  it('refuses an unlisted host before anything is sent', async () => {
    const { api, renewal } = listed(['other.example.com']);
    await expect(
      renewal.executeStreaming(request('GET'), statusOf),
    ).rejects.toMatchObject({ code: 'http.oauth2_host_not_allowed' });
    expect(api.sent).toEqual([]);
  });

  it('lets a wildcard cover subdomains, not the apex', async () => {
    const covered = listed(['*.example.com']);
    await expect(
      covered.renewal.executeStreaming(request('GET'), statusOf),
    ).resolves.toMatchObject({ body: 200 });
    const apex = listed(['*.api.example.com']);
    await expect(
      apex.renewal.executeStreaming(request('GET'), statusOf),
    ).rejects.toMatchObject({ code: 'http.oauth2_host_not_allowed' });
  });
});
