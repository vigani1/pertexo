import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createOpenTelemetrySdk,
  createStructuredLogger,
} from '@pertexo/observability';
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
type Encoding =
  | (typeof encodings)[number]
  | 'mixed'
  | 'ascii'
  | 'literal'
  | 'nested-2'
  | 'nested-3'
  | 'nested-4'
  | 'utf16le'
  | 'utf16be'
  | 'windows-1252'
  | 'percent-mixed'
  | 'percent-partial';
const encode = (value: string, encoding: Encoding): string => {
  if (encoding.startsWith('nested-')) {
    let result = value;
    for (let depth = 1; depth < Number(encoding.at(-1)); depth += 1)
      result = JSON.stringify({ credential: result }).replaceAll(
        'é',
        '\\u00e9',
      );
    return result;
  }
  const transforms: Partial<Record<Encoding, (text: string) => string>> = {
    uri: encodeURI,
    url: encodeURIComponent,
    'percent-upper': (text) =>
      [...Buffer.from(text)]
        .map((byte) => '%' + byte.toString(16).padStart(2, '0').toUpperCase())
        .join(''),
    'percent-mixed': (text) =>
      [...Buffer.from(text)]
        .map(
          (byte, index) =>
            '%' +
            (index % 2 === 0
              ? byte.toString(16).padStart(2, '0').toUpperCase()
              : byte.toString(16).padStart(2, '0')),
        )
        .join(''),
    'percent-partial': (text) => text.replaceAll('p', '%70'),
    base64url: (text) => Buffer.from(text).toString('base64url'),
    'basic-token': (text) => text.slice(6),
    form: (text) => new URLSearchParams({ value: text }).toString().slice(6),
    percent: (text) =>
      [...Buffer.from(text)]
        .map((byte) => '%' + byte.toString(16).padStart(2, '0'))
        .join(''),
    base64: (text) => Buffer.from(text).toString('base64'),
    'basic-password': (text) =>
      Buffer.from(text.slice(6), 'base64').toString('utf8').slice(5),
    basic: (text) => Buffer.from(text.slice(6), 'base64').toString('utf8'),
  };
  return transforms[encoding]?.(value) ?? value;
};
let origin: string;
const seen: string[] = [];
const traces: unknown[] = [];
const collector = createServer((incoming, response) => {
  void collectTelemetry(incoming, response);
});
async function collectTelemetry(
  incoming: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const parts: Buffer[] = [];
  for await (const chunk of incoming) {
    if (!(chunk instanceof Uint8Array))
      throw new Error('Expected telemetry bytes');
    parts.push(Buffer.from(chunk));
  }
  if (incoming.url === '/v1/traces')
    traces.push(JSON.parse(Buffer.concat(parts).toString()) as unknown);
  response.end('{}');
}
let telemetry: ReturnType<typeof createOpenTelemetrySdk>;
const logLines: string[] = [];
const logger = createStructuredLogger(
  {
    serviceName: 'credential-echo',
    serviceVersion: 'test',
    environment: 'test',
    logLevel: 'info',
    otlpHeaders: {},
  },
  {
    write(line) {
      logLines.push(line);
    },
  },
);
const server = createServer((incoming, response) => {
  const url = new URL(incoming.url ?? '/', 'http://echo.test');
  const encoding = url.searchParams.get('encoding') as Encoding;
  const header = String(incoming.headers['x-private']);
  seen.push(header);
  const echoed = encode(header, encoding);
  response.statusCode = url.pathname === '/error' ? 400 : 200;
  response.statusMessage = JSON.stringify(echoed)
    .replaceAll('é', '\\u00e9')
    .replaceAll('ÿ', '\\u00ff');
  const mime = url.searchParams.get('mime') ?? 'application/json';
  if (mime !== 'none') response.setHeader('content-type', mime);
  response.setHeader(
    'etag',
    JSON.stringify(echoed)
      .replaceAll('é', '\\u00e9')
      .replaceAll('ÿ', '\\u00ff')
      .replaceAll('\\"', '\\u0022'),
  );
  const charset = ['utf16le', 'utf16be', 'windows-1252'].includes(encoding)
    ? encoding.replace('utf16', 'utf-16')
    : undefined;
  if (charset !== undefined && mime !== 'none')
    response.setHeader('content-type', mime + '; charset=' + charset);
  const json = JSON.stringify({
    credential: echoed,
    [echoed]: 'key echo',
    items: [{ credential: echoed }],
    padding: 'x'.repeat(100),
  });
  let body = json;
  body = jsonEchoBody(json, echoed, encoding);
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
  if (url.searchParams.get('projection') === 'charset-invalid-bytes')
    body = JSON.stringify({ credential: header, padding: 'x'.repeat(100_000) });
  if (url.searchParams.get('projection') === 'work-limit') {
    body =
      '"' +
      String.raw`\u0061`.repeat(Math.floor((10_485_760 - 100) / 13)) +
      '"';
    for (let layer = 1; layer < 4; layer += 1) body = JSON.stringify(body);
  }
  writeEchoBody(response, url, body, { encoding, mime });
});
beforeAll(async () => {
  collector.listen(0, '127.0.0.1');
  await once(collector, 'listening');
  const collectorAddress = collector.address();
  if (collectorAddress === null || typeof collectorAddress === 'string')
    throw new Error('Missing collector');
  telemetry = createOpenTelemetrySdk({
    serviceName: 'credential-echo',
    serviceVersion: 'test',
    environment: 'test',
    logLevel: 'info',
    otlpHeaders: {},
    otlpHttpEndpoint: `http://127.0.0.1:${String(collectorAddress.port)}`,
  });
  telemetry.start();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Missing server');
  origin = `http://echo.example.test:${String(address.port)}`;
});
afterAll(async () => {
  await telemetry.shutdown();
  collector.close();
  await once(collector, 'close');
  expect(traces.length).toBeGreaterThan(0);
  const exported = assertCredentialUnrecoverable(traces);
  expect([...exported].join(' ')).toContain('credential-echo');
  expect([...exported].join(' ')).toContain('GET');

  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    }),
  );
});

// Every retained field, including response roots and body metadata, joins this matrix.
// Transport status text is deliberately omitted; logs/traces are checked for every case.
type BodyFields<T> = T extends { kind: infer Kind extends string }
  ? {
      [Field in keyof T & string]: Field extends 'value'
        ? T extends { encoding: infer Encoding extends string }
          ? `${Kind}.${Encoding}.${Field}`
          : `${Kind}.${Field}`
        : `${Kind}.${Field}`;
    }[keyof T & string]
  : `body.${keyof T & string}`;
type OutputFields<T> = T extends { body: infer Body }
  ? BodyFields<Body> | `response.${Exclude<keyof T, 'body'> & string}`
  : T extends { items: unknown }
    ? `pagination.${keyof T & string}`
    : T extends { pages: readonly (infer Page)[] }
      ? `pages.${keyof T & string}` | `page.${keyof Page & string}`
      : `output.${keyof T & string}`;
const retainedBodyPaths = {
  'transport.statusText': ['inline-json'],
  logs: ['inline-json'],
  traces: ['inline-json'],
  'response.status': ['inline-json'],
  'response.headers': ['response-headers'],
  'response.finalOrigin': ['inline-json'],
  'response.redirectCount': ['inline-json'],
  'inline.kind': ['inline-text'],
  'inline.encoding': ['inline-text'],
  'inline.byteLength': ['inline-text'],
  'inline.utf8.value': ['inline-text', 'inline-json'],
  'inline.base64.value': ['inline-text', 'inline-json'],
  'inline.json': ['parsed-json'],
  'artifact.artifactId': ['artifact-json', 'artifact-text'],
  'artifact.kind': ['artifact-json'],
  'artifact.byteLength': ['artifact-json'],
  'artifact.mediaType': ['artifact-json'],
  'artifact.sha256': ['artifact-json'],
  'error.method': ['error-excerpt'],
  'error.url': ['error-excerpt'],
  'error.status': ['error-excerpt'],
  'error.text.kind': ['error-excerpt'],
  'error.text.excerpt': ['error-excerpt'],
  'error.none.kind': ['error-excerpt'],
  'error.binary.kind': ['error-excerpt'],
  'error.too_large.kind': ['error-excerpt'],
  'pagination.items': ['pagination'],
  'pagination.headers': ['pagination'],
  'pagination.status': ['pagination'],
  'pagination.finalOrigin': ['pagination'],
  'pagination.pageCount': ['pagination'],
  'pagination.complete': ['pagination'],
  'pages.pages': ['page-artifact'],
  'pages.itemCount': ['page-artifact'],
  'pages.pageCount': ['page-artifact'],
  'pages.fetchedPageCount': ['page-artifact'],
  'pages.complete': ['page-artifact'],
  'pages.status': ['page-artifact'],
  'pages.headers': ['page-artifact'],
  'pages.finalOrigin': ['page-artifact'],
  'page.kind': ['page-artifact'],
  'page.artifactId': ['page-artifact'],
  'page.byteLength': ['page-artifact'],
  'page.mediaType': ['page-artifact'],
  'page.sha256': ['page-artifact'],
} as const satisfies Record<
  | 'transport.statusText'
  | 'logs'
  | 'traces'
  | OutputFields<HttpRequestOutput>
  | `error.${Exclude<keyof ServiceResponseFacts, 'body'>}`
  | `error.${BodyFields<ServiceResponseFacts['body']>}`,
  readonly string[]
>;
const scenarios = [...new Set(Object.values(retainedBodyPaths).flat())];
const labels = ['application/json', 'text/plain', 'none', 'image/png'] as const;
const matrixEncodings = [
  ...encodings,
  'mixed',
  'ascii',
  'literal',
  'nested-2',
  'nested-3',
  'nested-4',
  'utf16le',
  'utf16be',
  'windows-1252',
  'percent-mixed',
  'percent-partial',
] as const;
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
  ...['inline-json', 'artifact-json'].flatMap((mode) =>
    [
      'text/plain; charset: utf-16le',
      'text/plain; charset=\u00a0utf-16le',
      'text/plain; charset="\u00a0utf-16le"',
      // Only HTTP SP and HTAB may surround a parameter; other whitespace is malformed.
      'text/plain; charset=utf-16le\u00a0',
      'text/plain; \u00a0charset=utf-16le',
    ].map((mime) => ({
      mode,
      mime,
      encoding: 'literal' as const,
      oneByte: true,
      projection: 'charset-malformed-token',
    })),
  ),
  ...['inline-json', 'artifact-json'].map((mode) => ({
    mode,
    mime: 'text/plain; charset=utf-16le',
    encoding: 'literal' as const,
    oneByte: false,
    projection: 'charset-invalid-bytes',
  })),
  ...['inline-json', 'artifact-json'].map((mode) => ({
    mode,
    mime: 'application/json',
    encoding: 'literal' as const,
    oneByte: false,
    projection: 'work-limit',
  })),
  ...['inline-json', 'artifact-json'].flatMap((mode) =>
    [
      '',
      ' ',
      '""',
      '"unterminated',
      'utf-16le trailing',
      '; charset=utf-16le',
      'utf-8; charset=utf-16le',
    ].map((charset) => ({
      mode,
      mime: 'text/plain; charset=' + charset,
      encoding: 'literal' as const,
      oneByte: true,
      projection: 'charset-invalid',
    })),
  ),
  ...['inline-json', 'artifact-json'].map((mode) => ({
    mode,
    mime: 'text/plain; charset=bogus',
    encoding: 'literal' as const,
    oneByte: false,
    projection: 'charset-empty-body',
  })),
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
    const { header, timeoutMillis, maxResponseBytes, inlineResponseBytes } =
      echoRequestSettings(mode, projection, encoding);
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
        timeoutMillis,
        maxRedirects: 0,
        maxResponseBytes,
        inlineResponseBytes,
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
    if (projection.startsWith('charset-') || projection === 'work-limit') {
      const error: unknown = await operation.catch((reason: unknown) => reason);
      expect(error, JSON.stringify(error)).toBeInstanceOf(NodeExecutorFailure);
      if (!(error instanceof NodeExecutorFailure)) throw error;
      const completion = executorFailureCompletion(error);
      expect(completion).toMatchObject({
        status: 'executor_failure',
        failureKind: 'failed',
      });
      expect(completion).toMatchObject({
        safeErrorCode:
          projection === 'work-limit'
            ? 'http.response_redaction_limit'
            : 'http.response_encoding',
      });
      expect(completion).toHaveProperty(
        'errorSummary',
        expect.stringContaining(
          projection === 'work-limit'
            ? 'credential masking work limit'
            : 'unsupported or invalid text encoding',
        ),
      );
      assertCredentialUnrecoverable(completion);
      expect(stored).toEqual([]);
    } else if (
      mode === 'error-excerpt' ||
      (paged && mime !== 'application/json')
    ) {
      const error: unknown = await operation.catch((reason: unknown) => reason);
      expect(error, JSON.stringify(error)).toBeInstanceOf(NodeExecutorFailure);
      if (!(error instanceof NodeExecutorFailure)) throw error;
      const shown = executorFailureCompletion(error);
      assertCredentialUnrecoverable(shown);
      logger.warn('http.response_failed', { statusCode: 400 }, error);
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
      logger.info('http.response_received', { response: result.output });
      if (projection === 'many') {
        const elapsedMs = performance.now() - started;
        console.info(
          'HTTP_REDACTION_10MIB=' +
            JSON.stringify({
              elapsedMs,
              storedBytes: Buffer.concat(stored).length,
            }),
        );
        // A tripwire for the old 4-20 s per-string rescans, not a benchmark: shared CI
        // runners took up to 1.3 s here, against about 0.1 s locally.
        expect(elapsedMs).toBeLessThan(5_000);
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
    const traced = await fetch(
      origin.replace('echo.example.test', '127.0.0.1') +
        '/?encoding=' +
        encoding +
        '&mime=' +
        encodeURIComponent(mime),
      { headers: { 'x-private': header } },
    );
    await traced.arrayBuffer();
    assertCredentialUnrecoverable(logLines.splice(0));
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
    projection === 'normal' &&
    !encoding.startsWith('nested-')
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
  if (
    mode === 'pagination' &&
    mime === 'application/json' &&
    !encoding.startsWith('nested-')
  )
    expect(output).toMatchObject({
      items: [{ credential: '[Redacted]' }],
    });
  if (mode === 'artifact-json') {
    const decoded: unknown = JSON.parse(Buffer.concat(stored).toString('utf8'));
    if (!encoding.startsWith('nested-'))
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
      if (seen.size > 20_000)
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

function jsonEchoBody(
  json: string,
  echoed: string,
  encoding: Encoding,
): string {
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

  return body;
}

function writeEchoBody(
  response: ServerResponse,
  url: URL,
  body: string,
  { encoding, mime }: Readonly<{ encoding: Encoding; mime: string }>,
): void {
  if (url.searchParams.get('projection')?.startsWith('charset-')) {
    let bytes = Buffer.from(body, 'utf16le');
    if (url.searchParams.get('projection') === 'charset-invalid-bytes')
      bytes = Buffer.concat([bytes, Buffer.of(255)]);
    response.end(
      url.searchParams.get('projection') === 'charset-empty-body'
        ? undefined
        : bytes,
    );
  } else if (encoding === 'utf16le' || encoding === 'utf16be') {
    const bytes = Buffer.from(
      (mime === 'none' ? '\ufeff' : '') + body,
      'utf16le',
    );
    response.end(encoding === 'utf16be' ? bytes.swap16() : bytes);
  } else
    response.end(
      Buffer.from(body, encoding === 'windows-1252' ? 'latin1' : 'utf8'),
    );
}

function echoRequestSettings(
  mode: string,
  projection: string,
  encoding: Encoding,
) {
  let header = credential;
  if (encoding.startsWith('basic'))
    header = 'Basic ' + Buffer.from('user:' + credential).toString('base64');
  if (projection === 'work-limit' && mode === 'inline-json')
    header = 'a'.repeat(7990) + 'b';
  const large =
    projection === 'many' ||
    projection === 'work-limit' ||
    projection === 'charset-invalid-bytes';
  let inlineResponseBytes = 32_768;
  if (large) inlineResponseBytes = 262_144;
  if (mode.startsWith('artifact-')) inlineResponseBytes = 1;
  return {
    header,
    timeoutMillis: large ? 30_000 : 10_000,
    maxResponseBytes: large ? 10_485_760 : 32_768,
    inlineResponseBytes,
  };
}
