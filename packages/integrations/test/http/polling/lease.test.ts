import { expect, it } from 'vitest';

import { fetchHttpPollItems } from '../../../src/server.js';

it('sends no connected request when the poll lease expires during the secret check', async () => {
  const lease = new AbortController();
  const expiry = new DOMException('Poll lease expired', 'TimeoutError');
  const connectionId = 'feed-connection';
  const requests: string[] = [];

  const poll = fetchHttpPollItems(
    {
      config: {
        url: 'https://feed.example.com/items',
        intervalMinutes: 5,
        itemsPath: '$',
        itemKeyPath: '$.key',
      },
      connectionId,
      seenKeys: [],
      maxItems: 100,
      maxPages: 5,
      signal: lease.signal,
    },
    {
      connections: {
        resolve: () =>
          Promise.reject(new Error('Expected HTTP credential resolution')),
        resolveHttpCredential: () =>
          Promise.resolve({
            connectionId,
            providerKey: 'http',
            authType: 'http_headers',
            secretVersionId: 'current',
            secret: new TextEncoder().encode(
              '{"type":"http_headers","headers":{"authorization":"Bearer feed"}}',
            ),
          }),
        assertCurrent: () => {
          lease.abort(expiry);
          return Promise.resolve();
        },
      },
      httpClient: {
        executeStreaming: async (request) => {
          // The transport can send only after its pre-dispatch hook succeeds.
          await request.beforeDispatch();
          requests.push(request.url);
          throw new Error('The expired poll reached the provider');
        },
      },
    },
  );

  await expect(poll).rejects.toBe(expiry);
  expect(requests).toEqual([]);
});
