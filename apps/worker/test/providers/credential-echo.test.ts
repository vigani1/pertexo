import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  NodeHttpTransport,
  SecureHttpClient,
  parseAllowedPrivateNetworks,
} from '@pertexo/secrets/server';
import {
  NodeExecutorFailure,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import { provideHttpClient } from '../../src/providers/http-client.js';
import { createPlatformNodeRegistry } from '../../src/providers/node-registry.js';
import { executorFailureCompletion } from '../../src/attempts/delivery/executor-failure.js';

const credential = 'private- "quote\\path-é-ÿ';
const connectionId = '22222222-2222-4222-8222-222222222222';
const secretVersionId = '33333333-3333-4333-8333-333333333333';
const encodings = [
  'json',
  'unicode',
  'url',
  'form',
  'percent',
  'base64',
  'basic',
  'basic-password',
] as const;
type Encoding = (typeof encodings)[number] | 'mixed';
const encode = (value: string, encoding: Encoding): string => {
  switch (encoding) {
    case 'json':
      return value;
    case 'mixed':
      return value;
    case 'unicode':
      return value;
    case 'url':
      return encodeURIComponent(value);
    case 'form':
      return new URLSearchParams({ value }).toString().slice(6);
    case 'percent':
      return [...Buffer.from(value)]
        .map((byte) => '%' + byte.toString(16).padStart(2, '0'))
        .join('');
    case 'base64':
      return Buffer.from(value).toString('base64');
    case 'basic-password':
      return Buffer.from(value.slice(6), 'base64').toString('utf8').slice(5);
    case 'basic':
      return Buffer.from(value.slice(6), 'base64').toString('utf8');
  }
};
let origin: string;
const seen: string[] = [];
const server = createServer((incoming, response) => {
  const url = new URL(incoming.url ?? '/', 'http://echo.test');
  const encoding = url.searchParams.get('encoding') as Encoding;
  const header = String(incoming.headers['x-private']);
  seen.push(header);
  const echoed = encode(header, encoding);
  response.statusCode = url.pathname === '/error' ? 400 : 200;
  response.setHeader('content-type', 'application/json');
  const json = JSON.stringify({
    credential: echoed,
    [echoed]: 'key echo',
    items: [{ credential: echoed }],
    padding: 'x'.repeat(100),
  });
  let body = json;
  if (encoding === 'unicode')
    body = json
      .split(JSON.stringify(echoed))
      .join(
        '"' +
          Array.from(
            echoed,
            (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'),
          ).join('') +
          '"',
      );
  else if (encoding === 'mixed')
    body = json
      .split(JSON.stringify(echoed))
      .join(JSON.stringify(echoed).replaceAll('p', '\\u0070'));

  // Each escape or multibyte sequence crosses stream writes.
  for (const byte of Buffer.from(body)) response.write(Buffer.from([byte]));
  response.end();
});
beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Missing server');
  origin = `http://echo.example.test:${String(address.port)}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    }),
  );
});

it.each([
  ...encodings.flatMap((encoding) =>
    ['inline', 'error', 'artifact', 'pagination', 'page-artifact'].map(
      (mode) => ({ encoding, mode }),
    ),
  ),
  ...['inline', 'pagination', 'page-artifact'].map((mode) => ({
    encoding: 'mixed' as const,
    mode,
  })),
])(
  'redacts $encoding credential echoes in $mode outputs',
  async ({ encoding, mode }) => {
    const header =
      encoding === 'basic' || encoding === 'basic-password'
        ? 'Basic ' + Buffer.from('user:' + credential).toString('base64')
        : credential;
    const stored: Buffer[] = [];
    const httpClient = provideHttpClient(
      new SecureHttpClient(
        {
          resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
        },
        new NodeHttpTransport(),
        undefined,
        { allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32') },
      ),
    );
    const runtime: NodeExecutionRuntime = {
      workspaceId: connectionId,
      runId: connectionId,
      nodeRunId: connectionId,
      attemptId: connectionId,
      attemptNumber: 1,
      nodeId: 'http',
      invocationKey: 'http',
      sideEffectClass: 'safe',
      beforeDispatch: () => Promise.resolve(),
      connections: {
        assertCurrent: () => Promise.resolve(),
        resolve: () =>
          Promise.reject(new Error('Use resolved HTTP credentials')),
        resolveHttpCredential: () =>
          Promise.resolve({
            connectionId,
            providerKey: 'http',
            authType: 'http_headers',
            secretVersionId,
            secret: Buffer.from(
              JSON.stringify({
                type: 'http_headers',
                headers: { 'x-private': header },
              }),
            ),
          }),
      },
      artifacts: {
        write: async ({ body, mediaType }) => {
          const parts: Buffer[] = [];
          for await (const chunk of body) parts.push(Buffer.from(chunk));
          const bytes = Buffer.concat(parts);
          stored.push(bytes);
          return {
            artifactId: connectionId,
            byteLength: bytes.length,
            mediaType,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          };
        },
      },
    };
    const paged = mode === 'pagination' || mode === 'page-artifact';
    const operation = createPlatformNodeRegistry({
      httpRequest: { httpClient },
    }).execute({
      definition: { key: 'http.request', version: 1 },
      executor: { key: 'http.request', version: 1 },
      config: {
        url:
          origin +
          (mode === 'error' ? '/error' : '/') +
          '?encoding=' +
          encoding,
        method: 'GET',
        headers: {},
        timeoutMillis: 10_000,
        maxRedirects: 0,
        maxResponseBytes: 16_384,
        inlineResponseBytes: mode === 'artifact' ? 1 : 16_384,
        ...(paged
          ? {
              pagination: {
                mode: 'page',
                parameter: 'page',
                start: 1,
                itemsPath: '$.items',
                maxPages: 1,
                delayMillis: 0,
                ...(mode === 'page-artifact' ? { outputMode: 'pages' } : {}),
              },
            }
          : {}),
      },
      input: {},
      connectionRefs: { http_headers: connectionId },
      runtime,
      signal: new AbortController().signal,
    });
    if (mode === 'error') {
      const error: unknown = await operation.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(NodeExecutorFailure);
      if (!(error instanceof NodeExecutorFailure)) throw error;
      const shown = executorFailureCompletion(error);
      expect(shown).toMatchObject({
        errorSummary: expect.stringContaining('[Redacted]') as unknown,
      });
      expect(JSON.stringify(shown)).not.toContain(
        JSON.stringify(encode(header, encoding)).slice(1, -1),
      );
    } else {
      const result = await operation;
      const retained =
        JSON.stringify(result.output) + Buffer.concat(stored).toString('utf8');
      expect(retained).toContain('[Redacted]');
      expect(retained).not.toContain(credential);
      expect(retained).not.toContain(
        JSON.stringify(encode(header, encoding)).slice(1, -1),
      );
      if (mode === 'inline')
        expect(result.output).toMatchObject({
          body: {
            json: {
              credential: '[Redacted]',
              '[Redacted]': 'key echo',
              items: [{ credential: '[Redacted]' }],
            },
          },
        });
      if (mode === 'pagination')
        expect(result.output).toMatchObject({
          items: [{ credential: '[Redacted]' }],
        });
      if (mode === 'artifact' || mode === 'page-artifact')
        expect(stored.length).toBeGreaterThan(0);
    }
    expect(seen.at(-1)).toBe(header);
  },
);
