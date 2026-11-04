import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { httpHeadersCredentialSchema } from '@pertexo/contracts';
import {
  NodeHttpTransport,
  SecureHttpClient,
  parseAllowedPrivateNetworks,
} from '../../src/server.js';
import {
  FakeResolver,
  FakeTransport,
  request,
} from '../support/http-client.js';

it.each(['latin1', 'utf8'] as const)(
  'redacts a real Node header echo encoded as %s without changing the credential sent',
  async (encoding) => {
    const secret = 'private-é-ÿ-token';
    const seen: string[] = [];
    const server = createServer((incoming, response) => {
      const received = String(incoming.headers['x-private']);
      seen.push(received);
      response.setHeader(
        'content-type',
        encoding === 'latin1' ? 'application/octet-stream' : 'text/plain',
      );
      response.end(Buffer.from(`before:${received}:after`, encoding));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Server missing');
      const client = new SecureHttpClient(
        {
          resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
        },
        new NodeHttpTransport(),
        undefined,
        { allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32') },
      );
      const credential = httpHeadersCredentialSchema.parse({
        type: 'http_headers',
        headers: { 'x-private': secret },
      });
      const response = await client.execute(
        request({
          url: `http://echo.example.test:${String(address.port)}/`,
          headers: credential.headers,
          sensitiveValues: [secret],
        }),
      );
      expect(seen).toEqual([secret]);
      expect(Buffer.from(response.body).toString('utf8')).toBe(
        'before:[Redacted]:after',
      );
      expect(
        Buffer.from(response.body).includes(Buffer.from(secret, encoding)),
      ).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
    }
  },
);

it.each(['latin1', 'utf8'] as const)(
  'redacts overlapping %s credentials across every byte split and one-byte chunks',
  async (encoding) => {
    const secrets = ['abé', 'éÿend'];
    const bytes = Buffer.from('head:abéÿend:tail', encoding);
    const splits = Array.from({ length: bytes.length + 1 }, (_, at) => [
      bytes.subarray(0, at),
      bytes.subarray(at),
    ]);
    splits.push(Array.from(bytes, (byte) => Buffer.from([byte])));
    for (const split of splits) {
      const client = new SecureHttpClient(
        new FakeResolver({
          'api.example.test': [{ address: '8.8.8.8', family: 4 }],
        }),
        new FakeTransport(() =>
          Promise.resolve({
            status: 200,
            headers: {},
            close: () => undefined,
            body: {
              async *[Symbol.asyncIterator]() {
                for (const chunk of split) {
                  await Promise.resolve();
                  yield Buffer.from(chunk);
                }
              },
            },
          }),
        ),
      );
      const response = await client.execute(
        request({ sensitiveValues: secrets }),
      );
      expect(Buffer.from(response.body).toString('utf8')).toBe(
        'head:[Redacted]:tail',
      );
    }
  },
);

it.each(['json', 'percent', 'base64'] as const)(
  'redacts the %s echo of a quoted non-ASCII credential at every byte boundary',
  async (encoding) => {
    const secret = 'credential-"quote\\path-é-ÿ';
    let encoded = Buffer.from(secret).toString('base64');
    if (encoding === 'json') encoded = JSON.stringify(secret).slice(1, -1);
    else if (encoding === 'percent') encoded = encodeURIComponent(secret);

    const body = Buffer.from('before:' + encoded + ':after');
    const splits = Array.from({ length: body.length + 1 }, (_, at) => [
      body.subarray(0, at),
      body.subarray(at),
    ]);
    splits.push(Array.from(body, (byte) => Buffer.from([byte])));
    for (const chunks of splits) {
      const client = new SecureHttpClient(
        new FakeResolver({
          'api.example.test': [{ address: '8.8.8.8', family: 4 }],
        }),
        new FakeTransport(() =>
          Promise.resolve({
            status: 200,
            headers: {},
            close: () => undefined,
            body: (async function* () {
              for (const chunk of chunks) {
                await Promise.resolve();
                yield Buffer.from(chunk);
              }
            })(),
          }),
        ),
      );
      const response = await client.execute(
        request({ sensitiveValues: [secret] }),
      );
      expect(Buffer.from(response.body).toString('utf8')).toBe(
        'before:[Redacted]:after',
      );
    }
  },
);
