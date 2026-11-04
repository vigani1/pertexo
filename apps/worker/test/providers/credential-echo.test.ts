import type { HttpRequestOutput } from '@pertexo/integrations';
import type { ServiceResponseFacts } from '@pertexo/node-sdk/server';
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
import type { ProviderHttpClient } from '@pertexo/integrations/server';
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
  'basic-token',
  'uri',
  'base64url',
  'percent-upper',
  'unicode-upper',
] as const;
type Encoding = (typeof encodings)[number] | 'mixed' | 'ascii' | 'literal';
const encode = (value: string, encoding: Encoding): string => {
  switch (encoding) {
    case 'json':
    case 'literal':
      return value;
    case 'ascii':
    case 'mixed':
      return value;
    case 'unicode':
    case 'unicode-upper':
      return value;
    case 'uri':
      return encodeURI(value);
    case 'percent-upper':
      return [...Buffer.from(value)]
        .map((byte) => '%' + byte.toString(16).padStart(2, '0').toUpperCase())
        .join('');
    case 'base64url':
      return Buffer.from(value).toString('base64url');
    case 'basic-token':
      return value.slice(6);
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
  const mime = url.searchParams.get('mime') ?? 'application/json';
  if (mime !== 'none') response.setHeader('content-type', mime);
  const json = JSON.stringify({
    credential: echoed,
    [echoed]: 'key echo',
    items: [{ credential: echoed }],
    padding: 'x'.repeat(100),
  });
  let body = json;
  if (encoding === 'unicode' || encoding === 'unicode-upper')
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
  if (encoding === 'unicode-upper')
    body = body.replace(
      /\\u([a-f0-9]{4})/gu,
      (_match, hex: string) => '\\u' + hex.toUpperCase(),
    );
  else if (encoding === 'mixed')
    body = json
      .split(JSON.stringify(echoed))
      .join(JSON.stringify(echoed).replaceAll('p', '\\u0070'));
  else if (encoding === 'ascii')
    body = json.replaceAll('é', '\\u00e9').replaceAll('ÿ', '\\u00ff');

  if (url.searchParams.get('text') === 'true')
    body =
      'before:' +
      (encoding === 'literal' ? echoed : JSON.stringify(echoed).slice(1, -1)) +
      ':after';
  if (encoding === 'ascii')
    body = body.replaceAll('é', '\\u00e9').replaceAll('ÿ', '\\u00ff');
  if (url.searchParams.get('projection') === 'malformed')
    body += '\nprovider diagnostic';
  if (url.searchParams.get('projection') === 'wide')
    body = body.slice(0, -1) + ',"wide":[' + '0,'.repeat(8100) + '0]}';
  if (url.searchParams.get('projection') === 'many') {
    const prefix = body.slice(0, -1) + ',"many":[';
    body =
      prefix +
      '"x",'.repeat(
        Math.floor((10_485_760 - Buffer.byteLength(prefix) - 6) / 4),
      ) +
      '"x"]}';
  }
  response.end(body);
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

// Retained-body paths are inventoried here; each runs through the same privacy assertion.
type BodyMetadata = 'kind' | 'encoding' | 'byteLength' | 'mediaType' | 'sha256';
type BodyFields<T> = T extends { kind: infer Kind extends string }
  ? {
      [Field in Exclude<keyof T, BodyMetadata> & string]: Field extends 'value'
        ? T extends { encoding: infer Encoding extends string }
          ? `${Kind}.${Encoding}.${Field}`
          : `${Kind}.${Field}`
        : `${Kind}.${Field}`;
    }[Exclude<keyof T, BodyMetadata> & string]
  : `body.${Exclude<keyof T, BodyMetadata> & string}`;
type ResponseMetadata =
  | 'kind'
  | 'status'
  | 'headers'
  | 'finalOrigin'
  | 'redirectCount'
  | 'pageCount'
  | 'fetchedPageCount'
  | 'itemCount'
  | 'complete';
type OutputFields<T> = T extends { body: infer Body }
  ? BodyFields<Body>
  : T extends { items: unknown }
    ? `pagination.${Exclude<keyof T, ResponseMetadata> & string}`
    : T extends { pages: unknown }
      ? `pages.${Exclude<keyof T, ResponseMetadata> & string}`
      : `output.${Exclude<keyof T, ResponseMetadata> & string}`;
const retainedBodyPaths = {
  'inline.utf8.value': ['inline-text', 'inline-json'],
  'inline.base64.value': ['inline-text', 'inline-json'],
  'inline.json': ['parsed-json'],
  'artifact.artifactId': ['artifact-json', 'artifact-text'],
  'error.text.excerpt': ['error-excerpt'],
  'pagination.items': ['pagination'],
  'pages.pages': ['page-artifact'],
} as const satisfies Record<
  | OutputFields<HttpRequestOutput>
  | `error.${BodyFields<ServiceResponseFacts['body']>}`,
  readonly string[]
>;
const scenarios = [...new Set(Object.values(retainedBodyPaths).flat())];
const labels = ['application/json', 'text/plain', 'none', 'image/png'] as const;
const matrixEncodings = [...encodings, 'mixed', 'ascii', 'literal'] as const;
const matrix = scenarios.flatMap((mode) =>
  labels.flatMap((mime) =>
    matrixEncodings.flatMap((encoding) =>
      [false, true].map((oneByte) => ({
        mode,
        mime,
        encoding,
        oneByte,
        projection: 'normal',
      })),
    ),
  ),
);
const fallbacks = ['inline-json', 'parsed-json', 'error-excerpt'].flatMap(
  (mode) =>
    ['malformed', 'wide'].flatMap((projection) =>
      labels.flatMap((mime) =>
        [false, true].map((oneByte) => ({
          mode,
          mime,
          encoding: 'ascii' as const,
          oneByte,
          projection,
        })),
      ),
    ),
);
it.each([
  ...matrix,
  ...fallbacks,
  {
    mode: 'artifact-json',
    mime: 'application/json',
    encoding: 'ascii' as const,
    oneByte: false,
    projection: 'many',
  },
])(
  'keeps $mode private for $mime / $encoding / oneByte=$oneByte / $projection',
  async ({ encoding, mode, mime, oneByte, projection }) => {
    const header = encoding.startsWith('basic')
      ? 'Basic ' + Buffer.from('user:' + credential).toString('base64')
      : credential;
    const stored: Buffer[] = [];
    const transport = new NodeHttpTransport();
    const client = provideHttpClient(
      new SecureHttpClient(
        {
          resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
        },
        {
          dispatch: async (request) => {
            const response = await transport.dispatch(request);
            return {
              ...response,
              body: (async function* () {
                for await (const chunk of response.body) {
                  if (oneByte) {
                    for (const byte of chunk) yield Uint8Array.of(byte);
                  } else yield chunk;
                }
              })(),
            };
          },
        },
        undefined,
        { allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32') },
      ),
    );
    const httpClient: ProviderHttpClient = client;
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
    const started = performance.now();
    const operation = createPlatformNodeRegistry({
      httpRequest: { httpClient },
    }).execute({
      definition: { key: 'http.request', version: 1 },
      executor: { key: 'http.request', version: 1 },
      config: {
        url:
          origin +
          (mode === 'error-excerpt' ? '/error' : '/') +
          '?encoding=' +
          encoding +
          '&mime=' +
          encodeURIComponent(mime) +
          '&text=' +
          String(mode === 'inline-text' || mode === 'artifact-text') +
          '&projection=' +
          projection,
        method: 'GET',
        headers: {},
        timeoutMillis: projection === 'many' ? 30_000 : 10_000,
        maxRedirects: 0,
        maxResponseBytes: projection === 'many' ? 10_485_760 : 32_768,
        inlineResponseBytes: mode.startsWith('artifact-') ? 1 : 32_768,
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
    if (mode === 'error-excerpt' || (paged && mime !== 'application/json')) {
      const error: unknown = await operation.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(NodeExecutorFailure);
      if (!(error instanceof NodeExecutorFailure)) throw error;
      const shown = executorFailureCompletion(error);
      assertCredentialUnrecoverable(shown);
      if (
        mode === 'error-excerpt' &&
        (mime === 'application/json' || mime === 'text/plain')
      )
        expect(JSON.stringify(shown)).toContain('[Redacted]');
      expect(JSON.stringify(shown)).not.toContain(
        JSON.stringify(encode(header, encoding)).slice(1, -1),
      );
    } else {
      const result = await operation;
      if (projection === 'many') {
        const elapsedMs = performance.now() - started;
        console.info(
          'HTTP_REDACTION_10MIB=' +
            JSON.stringify({
              elapsedMs,
              storedBytes: Buffer.concat(stored).length,
            }),
        );
        expect(elapsedMs).toBeLessThan(1_000);
        expect(Buffer.concat(stored).length).toBeGreaterThan(10_000_000);
      }
      assertRetainedOutput(result.output, stored, {
        mode,
        mime,
        projection,
        encoding,
        header,
      });
    }
    expect(seen.at(-1)).toBe(header);
  },
  30_000,
);

function assertRetainedOutput(
  output: unknown,
  stored: readonly Buffer[],
  {
    mode,
    mime,
    projection,
    encoding,
    header,
  }: Readonly<{
    mode: string;
    mime: string;
    projection: string;
    encoding: Encoding;
    header: string;
  }>,
): void {
  const retained =
    JSON.stringify(output) + Buffer.concat(stored).toString('utf8');
  const decoded = assertCredentialUnrecoverable({
    output,
    artifact: Buffer.concat(stored).toString('utf8'),
  });
  expect([...decoded].some((value) => value.includes('[Redacted]'))).toBe(true);
  expect(retained).not.toContain(credential);
  expect(retained).not.toContain(
    JSON.stringify(encode(header, encoding)).slice(1, -1),
  );
  if (
    mode === 'parsed-json' &&
    mime === 'application/json' &&
    projection === 'normal'
  )
    expect(output).toMatchObject({
      body: {
        json: {
          credential: '[Redacted]',
          '[Redacted]': 'key echo',
          items: [{ credential: '[Redacted]' }],
        },
      },
    });
  if (
    (mode === 'inline-json' || mode === 'parsed-json') &&
    (mime !== 'application/json' || projection !== 'normal')
  )
    expect(output).not.toHaveProperty('body.json');
  if (mode === 'pagination' && mime === 'application/json')
    expect(output).toMatchObject({
      items: [{ credential: '[Redacted]' }],
    });
  if (mode === 'artifact-json') {
    const decoded: unknown = JSON.parse(Buffer.concat(stored).toString('utf8'));
    expect(decoded).toMatchObject({
      credential: '[Redacted]',
      '[Redacted]': 'key echo',
      items: [{ credential: '[Redacted]' }],
    });
    expect(JSON.stringify(decoded)).not.toContain(credential);
  }
  if (mode.startsWith('artifact-') || mode === 'page-artifact')
    expect(stored.length).toBeGreaterThan(0);
}

function assertCredentialUnrecoverable(retained: unknown): ReadonlySet<string> {
  const pending: unknown[] = [retained];
  const seen = new Set<string>();
  for (const value of pending) {
    if (typeof value === 'string') {
      if (seen.has(value)) continue;
      seen.add(value);
      expect(value).not.toContain(credential);
      if (seen.size > 200)
        throw new Error('Unbounded credential recovery fixture');
      let parsed = false;
      try {
        pending.push(JSON.parse(value) as unknown);
        parsed = true;
      } catch {
        /* The body may contain provider diagnostics after JSON. */
      }
      for (const token of parsed ? [] : value.matchAll(/"(?:[^"\\]|\\.)*"/gu)) {
        try {
          pending.push(JSON.parse(token[0]) as unknown);
        } catch {
          /* Only independently decodable strings matter. */
        }
      }
      try {
        pending.push(decodeURIComponent(value.replaceAll('+', ' ')));
      } catch {
        /* Not percent-encoded. */
      }
      if (/^[A-Za-z0-9+/_=-]{8,}$/u.test(value))
        pending.push(Buffer.from(value, 'base64').toString('utf8'));
      if (value.includes('\\')) {
        try {
          pending.push(JSON.parse('"' + value + '"') as unknown);
        } catch {
          /* Not a complete JSON string. */
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        const member: unknown = Reflect.get(value, key);
        pending.push(key, member);
      }
    }
  }
  return seen;
}
