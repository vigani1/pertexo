import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { findConnectionDefinition } from '@pertexo/node-catalog';
import { parseAllowedPrivateNetworks } from '@pertexo/secrets/server';
import { expect, it } from 'vitest';
import { decodeCredential } from '../../../src/connections/testing/credentials.js';
import { testHttpConnection } from '../../../src/connections/testing/http.js';
import { createNodeProviderHttpClient } from '../../../src/platform/connections/http-client.js';

it('tests the configured model API base with the endpoint-specific recipe', async () => {
  const key = 'synthetic-probe-key';
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/custom/v1/models') {
      response.writeHead(404).end();
      return;
    }
    requests.push({
      bearer: request.headers.authorization,
      key: request.headers['x-api-key'],
      version: request.headers['anthropic-version'],
    });
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end('{"data":[{"id":"fake-model"}]}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    const definition = findConnectionDefinition('model_api_key', 'ai');
    if (
      address === null ||
      typeof address === 'string' ||
      definition === undefined
    )
      throw new Error('Missing fake provider or registered credential');
    const baseUrl = `http://127.0.0.1:${String(address.port)}/custom/v1/`;
    const client = createNodeProviderHttpClient({
      allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
    });
    let dispatches = 0;
    for (const endpoint of ['vllm', 'anthropic']) {
      const decoded = decodeCredential(
        new TextEncoder().encode(
          JSON.stringify({
            type: 'model_api_key',
            apiKey: key,
            endpoint,
            baseUrl,
          }),
        ),
        definition,
      );
      if (decoded.recipe.kind !== 'http')
        throw new Error('Missing HTTP test recipe');
      await expect(
        testHttpConnection(client, {
          ...decoded,
          recipe: decoded.recipe,
          request: { providerKey: 'ai' },
          command: {
            connectionId: randomUUID(),
            idempotencyKey: 'fixture-test',
          },
          timeoutMillis: 5_000,
          maxRedirects: 3,
          maxResponseBytes: 1_024,
          signal: new AbortController().signal,
          beforeDispatch: () => {
            dispatches += 1;
            return Promise.resolve();
          },
        }),
      ).resolves.toEqual({ ok: true, httpStatus: 200 });
    }
    expect(requests).toEqual([
      { bearer: `Bearer ${key}`, key: undefined, version: undefined },
      { bearer: undefined, key, version: '2023-06-01' },
    ]);
    expect(dispatches).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      }),
    );
  }
});
