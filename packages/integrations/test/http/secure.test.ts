import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';
import { assertPublicAddress } from '../../src/http/transport/address-policy.js';
import { NodeHttpTransport } from '../../src/server.js';
import { encoder, decoder } from '../support/http-client.js';
describe('public network address policy', () => {
  it.each(['provider.example.test', '999.1.1.1', 'not-an-address'])(
    'rejects non-IP address %s',
    (address) => {
      expect(() => assertPublicAddress(address)).toThrow('invalid address');
    },
  );

  it.each([
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '64:ff9b::c000:201',
    '100::1',
    '2001:db8::1',
    '2002:0a00:1::1',
    '3fff::1',
    'fc00::1',
    'fe80::1',
    'ff00::1',
  ])('blocks non-public address %s', (address) => {
    expect(() => assertPublicAddress(address)).toThrow();
  });

  it.each([
    ['8.8.8.8', 4],
    ['1.1.1.1', 4],
    ['2606:4700:4700::1111', 6],
    ['2001:4860:4860::8888', 6],
  ] as const)('accepts public address %s', (address, family) => {
    expect(assertPublicAddress(address)).toBe(family);
  });
});
describe('Node HTTP transport', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error === undefined) resolve();
              else reject(error);
            });
          }),
      ),
    );
  });

  it('connects only to the supplied pinned address while preserving the URL host', async () => {
    const server = createServer((incoming, response) => {
      response.setHeader('content-type', 'text/plain');
      response.end(incoming.headers.host ?? 'missing');
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('test server did not bind a TCP port');
    const transport = new NodeHttpTransport();
    const response = await transport.dispatch({
      url: new URL(`http://does-not-resolve.invalid:${String(address.port)}/`),
      address: { address: '127.0.0.1', family: 4 },
      method: 'GET',
      headers: {},
      timeoutMillis: 1_000,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) chunks.push(chunk);
    response.close();
    expect(decoder.decode(Buffer.concat(chunks))).toBe(
      `does-not-resolve.invalid:${String(address.port)}`,
    );

    const posted = encoder.encode('request-body');
    const postResponse = await transport.dispatch({
      url: new URL(`http://does-not-resolve.invalid:${String(address.port)}/`),
      address: { address: '127.0.0.1', family: 4 },
      method: 'POST',
      headers: {},
      body: posted,
      timeoutMillis: 1_000,
    });
    for await (const _chunk of postResponse.body) {
      // Drain the body; the chunks are not needed.
    }
    postResponse.close();
  });

  it('destroys a native request when cancellation wins before response acquisition', async () => {
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let socketClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      socketClosed = resolve;
    });
    const server = createServer((incoming) => {
      requestStarted?.();
      incoming.socket.once('close', () => {
        socketClosed?.();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('test server did not bind a TCP port');
    const controller = new AbortController();
    const pending = new NodeHttpTransport().dispatch({
      url: new URL(
        `http://does-not-resolve.invalid:${String(address.port)}/cancel`,
      ),
      address: { address: '127.0.0.1', family: 4 },
      method: 'GET',
      headers: {},
      timeoutMillis: 1_000,
      signal: controller.signal,
    });
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await closed;
  });
});
