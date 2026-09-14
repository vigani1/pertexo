import type * as httpTypes from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';

import {
  SpanKind,
  SpanStatusCode,
  type Exception,
  type Span,
  type SpanStatus,
} from '@opentelemetry/api';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { node } from '@opentelemetry/sdk-node';
import { beforeAll, describe, expect, it } from 'vitest';

import { createNodeInstrumentations } from '../src/telemetry.js';

const QUERY_SECRET = 'oauth-code-secret';
const STATE_SECRET = 'oauth-state-secret';
const ARBITRARY_SECRET = 'arbitrary-query-secret';
const ERROR_QUERY_SECRET = 'error-query-secret';
const HOOK_ERROR_QUERY_SECRET = 'hook-error-query-secret';
const FRAGMENT_SECRET = 'fragment-secret';
const MALFORMED_CREDENTIAL_SECRET = 'malformed-credential-secret';
const ERROR_CODE_SECRET = 'error-code-secret';
const MULTI_USERINFO_SECRET = 'opaque-userinfo-secret';
const SPACED_QUERY_SECRET = 'spaced-query-secret';

type FinishedSpan = ReturnType<
  node.InMemorySpanExporter['getFinishedSpans']
>[number];
type HttpModule = typeof httpTypes;
type HttpServer = httpTypes.Server;
type HttpClientRequest = httpTypes.ClientRequest;

type Settled<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ error: unknown; ok: false }>;

async function settle<T>(operation: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { error, ok: false };
  }
}

async function listen(server: HttpServer): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the test server to have a TCP address');
  }

  return address.port;
}

async function close(server: HttpServer): Promise<void> {
  if (!server.listening) {
    return;
  }

  server.close();
  await once(server, 'close');
}

function request(
  http: HttpModule,
  url: string,
  options?: httpTypes.RequestOptions,
): Promise<{ readonly statusCode: number | undefined }> {
  return new Promise((resolve, reject) => {
    let clientRequest: HttpClientRequest;
    const responseHandler = (response: httpTypes.IncomingMessage) => {
      response.resume();
      response.once('end', () => {
        resolve({ statusCode: response.statusCode });
      });
    };

    try {
      clientRequest =
        options === undefined
          ? http.get(url, responseHandler)
          : http.get(url, options, responseHandler);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    clientRequest.once('error', reject);
  });
}

function spansFor(
  spans: readonly FinishedSpan[],
  kind: SpanKind,
  path: string,
): FinishedSpan[] {
  return spans.filter(
    (span) =>
      span.kind === kind &&
      (span.attributes['url.path'] === path ||
        span.attributes['url.full']?.toString().endsWith(path)),
  );
}

describe('HTTP telemetry URL privacy', () => {
  it('sanitizes exceptions and status messages through the configured HTTP hook', () => {
    const instrumentation = createNodeInstrumentations().find(
      (candidate) => candidate instanceof HttpInstrumentation,
    );
    const hook = instrumentation?.getConfig().requestHook;
    if (hook === undefined) {
      throw new Error('Expected the configured HTTP request hook');
    }
    const exceptions: Exception[] = [];
    const statuses: SpanStatus[] = [];
    const span = {
      recordException: (exception: Exception) => {
        exceptions.push(exception);
      },
      setStatus: (status: SpanStatus) => {
        statuses.push(status);
        return span;
      },
    } as Span;
    hook(span, {} as never);
    hook(span, {} as never);

    const hostileException = new Proxy(Object.create(null) as object, {
      has: () => {
        throw new Error('hostile-exception-inspection-secret');
      },
    });

    for (const exception of [
      'string-secret',
      null,
      42,
      {},
      { code: 1.5, message: 'fractional-secret' },
      { code: Number.POSITIVE_INFINITY, message: 'infinite-secret' },
      { code: 2_147_483_648, message: 'range-secret' },
      hostileException,
    ]) {
      span.recordException(exception as Exception);
    }
    span.recordException({ name: 'TypeError', message: 'name-secret' });
    span.recordException({ code: 'ECONNRESET', message: 'code-secret' });
    const customError = new Error('custom-error-secret');
    customError.name = 'SyntheticSecretType';
    span.recordException(customError);
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'status-secret' });
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'ETIMEDOUT' });
    span.setStatus({ code: SpanStatusCode.OK });

    expect(exceptions).toEqual([
      '[Redacted exception]',
      { name: 'NonError' },
      { name: 'NonError' },
      { name: 'NonError' },
      { name: 'NonError' },
      { name: 'NonError' },
      { name: 'NonError' },
      { name: 'NonError' },
      { name: 'NonError' },
      { name: 'NonError' },
      { name: 'Error' },
    ]);
    expect(statuses).toEqual([
      { code: SpanStatusCode.ERROR },
      { code: SpanStatusCode.ERROR },
      { code: SpanStatusCode.OK },
    ]);
    expect(JSON.stringify({ exceptions, statuses })).not.toContain('secret');
  });

  it.each(['', 'not a URL', 'ftp://user:secret@example.test'])(
    'uses a safe fallback for an invalid Undici origin: %s',
    (origin) => {
      const instrumentation = createNodeInstrumentations().find(
        (candidate) => candidate instanceof UndiciInstrumentation,
      );
      const hook = instrumentation?.getConfig().startSpanHook;
      if (hook === undefined) {
        throw new Error('Expected the configured Undici start span hook');
      }
      expect(
        hook({
          origin,
          method: 'GET',
          path: '/callback?code=secret#secret',
          headers: '',
          addHeader: () => undefined,
          throwOnError: false,
          completed: false,
          aborted: false,
          idempotent: true,
          contentLength: null,
          contentType: null,
          body: null,
        }),
      ).toMatchObject({
        'url.full': 'http://localhost/callback',
        'url.path': '/callback',
        'url.query': undefined,
      });
    },
  );

  it.each<{
    readonly options: httpTypes.RequestOptions;
    readonly expectedUrl: string;
  }>([
    { options: {}, expectedUrl: 'http://localhost/' },
    {
      options: { protocol: 'https:', hostname: 'example.test', port: 443 },
      expectedUrl: 'https://example.test/',
    },
    {
      options: {
        protocol: 'https:',
        host: 'user:secret@example.test:8443',
        path: '/callback?code=secret#secret',
      },
      expectedUrl: 'https://example.test:8443/callback',
    },
    {
      options: { host: '[invalid', path: 'http://[invalid', port: 1.5 },
      expectedUrl: 'http://localhost/',
    },
    {
      options: { hostname: '', port: 'secret' },
      expectedUrl: 'http://localhost/',
    },
    {
      options: { hostname: 'example.test', port: 65_536, path: '' },
      expectedUrl: 'http://example.test/',
    },
    {
      options: { hostname: 'example.test', port: '65535', path: '/ok' },
      expectedUrl: 'http://example.test:65535/ok',
    },
  ])(
    'exports a safe URL for boundary request options: $expectedUrl',
    ({ options, expectedUrl }) => {
      const instrumentation = createNodeInstrumentations().find(
        (candidate) => candidate instanceof HttpInstrumentation,
      );
      const hook = instrumentation?.getConfig().startOutgoingSpanHook;
      if (hook === undefined) {
        throw new Error('Expected the configured HTTP outgoing span hook');
      }

      const attributes = hook(options);
      expect(attributes).toMatchObject({
        'http.target': undefined,
        'http.url': undefined,
        'url.query': undefined,
        'url.full': expectedUrl,
      });
      expect(JSON.stringify(attributes)).not.toContain('secret');
    },
  );

  async function captureConfiguredHttpExport() {
    const exporter = new node.InMemorySpanExporter();
    const provider = new node.NodeTracerProvider({
      spanProcessors: [new node.SimpleSpanProcessor(exporter)],
    });
    const instrumentations = createNodeInstrumentations();
    const httpInstrumentation = instrumentations.find(
      (instrumentation) =>
        instrumentation.instrumentationName ===
        '@opentelemetry/instrumentation-http',
    );
    const undiciInstrumentation = instrumentations.find(
      (instrumentation) =>
        instrumentation.instrumentationName ===
        '@opentelemetry/instrumentation-undici',
    );

    if (
      httpInstrumentation === undefined ||
      undiciInstrumentation === undefined
    ) {
      throw new Error('Expected HTTP and Undici instrumentation');
    }

    const require = createRequire(import.meta.url);
    const http = require('http') as HttpModule;
    const server = http.createServer((request, response) => {
      if (request.url?.startsWith('/undici-client')) {
        response.statusCode = 503;
      }
      response.end('ok');
    });
    let closedServer: HttpServer | undefined;

    const capture = await settle(async () => {
      httpInstrumentation.setTracerProvider(provider);
      undiciInstrumentation.setTracerProvider(provider);
      httpInstrumentation.enable();
      undiciInstrumentation.enable();

      const port = await listen(server);
      const portText = String(port);
      const origin = `http://127.0.0.1:${portText}`;

      await request(
        http,
        `http://user:password@127.0.0.1:${portText}/http-client?code=${QUERY_SECRET}&state=${STATE_SECRET}&arbitrary=${ARBITRARY_SECRET}`,
      );
      const fetchResponse = await fetch(
        `${origin}/undici-client?code=${QUERY_SECRET}&state=${STATE_SECRET}&arbitrary=${ARBITRARY_SECRET}`,
      );
      await fetchResponse.arrayBuffer();

      closedServer = http.createServer();
      const closedPort = await listen(closedServer);
      await close(closedServer);
      const closedPortText = String(closedPort);
      const closedOrigin = `http://127.0.0.1:${closedPortText}`;

      await expect(
        request(
          http,
          `http://user:password@127.0.0.1:${closedPortText}/http-error?code=${ERROR_QUERY_SECRET}&state=${STATE_SECRET}&arbitrary=${ARBITRARY_SECRET}`,
        ),
      ).rejects.toBeDefined();
      await expect(
        request(
          http,
          `http://user:password@example.test:${portText}/http-error-hook?code=${HOOK_ERROR_QUERY_SECRET}&state=${STATE_SECRET}&arbitrary=${ARBITRARY_SECRET}`,
          {
            lookup: (_hostname, _options, callback) => {
              const error = Object.assign(
                new Error(
                  `lookup failed for http://user:password@${MULTI_USERINFO_SECRET}@example.test:${portText}/http-error-hook?code=${HOOK_ERROR_QUERY_SECRET} trailing=${SPACED_QUERY_SECRET}#${FRAGMENT_SECRET}`,
                ),
                {
                  code: `http://user:password@${MULTI_USERINFO_SECRET}@example.test:${portText}/error?code=${ERROR_CODE_SECRET} trailing=${SPACED_QUERY_SECRET}#${FRAGMENT_SECRET}`,
                },
              );
              callback(error, '', 4);
            },
          },
        ),
      ).rejects.toBeDefined();
      await expect(
        fetch(
          `${closedOrigin}/undici-error?code=${ERROR_QUERY_SECRET}&state=${STATE_SECRET}&arbitrary=${ARBITRARY_SECRET}`,
        ),
      ).rejects.toBeDefined();
      await expect(
        request(
          http,
          `http://user:password@[bad-host#${MALFORMED_CREDENTIAL_SECRET}`,
        ),
      ).rejects.toBeDefined();

      const spans = exporter.getFinishedSpans();
      const serverSpans = spansFor(spans, SpanKind.SERVER, '/http-client');
      const httpClientSpans = spansFor(spans, SpanKind.CLIENT, '/http-client');
      const undiciClientSpans = spansFor(
        spans,
        SpanKind.CLIENT,
        '/undici-client',
      );
      const httpErrorSpans = spansFor(spans, SpanKind.CLIENT, '/http-error');
      const hookErrorSpans = spansFor(
        spans,
        SpanKind.CLIENT,
        '/http-error-hook',
      );
      const undiciErrorSpans = spansFor(
        spans,
        SpanKind.CLIENT,
        '/undici-error',
      );
      const malformedSpans = spans.filter(
        (span) =>
          span.kind === SpanKind.CLIENT &&
          span.attributes['url.full'] === 'http://localhost/',
      );

      return Object.freeze({
        closedOrigin,
        hookErrorSpans,
        httpClientSpans,
        httpErrorSpans,
        malformedSpans,
        origin,
        portText,
        serverSpans,
        spans,
        undiciClientSpans,
        undiciErrorSpans,
      });
    });
    const cleanupResults = await Promise.allSettled([
      close(server),
      closedServer === undefined ? Promise.resolve() : close(closedServer),
      Promise.resolve().then(() => {
        httpInstrumentation.disable();
      }),
      Promise.resolve().then(() => {
        undiciInstrumentation.disable();
      }),
      provider.shutdown(),
    ]);
    const cleanupFailures = cleanupResults
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      .map(({ reason }): unknown => reason as unknown);
    if (!capture.ok) {
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [capture.error, ...cleanupFailures],
          'HTTP telemetry capture and cleanup failed',
        );
      }
      throw capture.error;
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        cleanupFailures,
        'HTTP telemetry test cleanup failed',
      );
    }
    return capture.value;
  }

  describe('configured HTTP and Undici export scenarios', () => {
    let captured!: Awaited<ReturnType<typeof captureConfiguredHttpExport>>;

    beforeAll(async () => {
      captured = await captureConfiguredHttpExport();
    });

    it('retains safe server and Node HTTP client data', () => {
      const { httpClientSpans, origin, serverSpans } = captured;

      expect(serverSpans).toHaveLength(1);
      expect(httpClientSpans).toHaveLength(1);
      expect(serverSpans[0]?.attributes).toEqual(
        expect.objectContaining({
          'http.request.method': 'GET',
          'http.response.status_code': 200,
          'url.path': '/http-client',
        }),
      );
      expect(httpClientSpans[0]?.attributes).toEqual(
        expect.objectContaining({
          'http.request.method': 'GET',
          'http.response.status_code': 200,
          'server.address': '127.0.0.1',
          'url.full': `${origin}/http-client`,
        }),
      );
    });

    it('retains safe Undici response data', () => {
      const { origin, undiciClientSpans } = captured;

      expect(undiciClientSpans).toHaveLength(1);
      expect(undiciClientSpans[0]?.attributes).toEqual(
        expect.objectContaining({
          'http.request.method': 'GET',
          'http.response.status_code': 503,
          'server.address': '127.0.0.1',
          'url.full': `${origin}/undici-client`,
        }),
      );
    });

    it('sanitizes a refused Node HTTP connection', () => {
      const { closedOrigin, httpErrorSpans } = captured;

      expect(httpErrorSpans).toHaveLength(1);
      expect(httpErrorSpans[0]?.status.code).toBe(SpanStatusCode.ERROR);
      expect(httpErrorSpans[0]?.events[0]?.attributes).toEqual(
        expect.objectContaining({ 'exception.type': 'Error' }),
      );
      expect(httpErrorSpans[0]?.status.message).toBeUndefined();
      expect(httpErrorSpans[0]?.attributes).toEqual(
        expect.objectContaining({
          'http.request.method': 'GET',
          'server.address': '127.0.0.1',
          'url.full': `${closedOrigin}/http-error`,
        }),
      );
    });

    it('sanitizes a custom lookup failure with hostile URL-shaped text', () => {
      const { hookErrorSpans, portText } = captured;

      expect(hookErrorSpans).toHaveLength(1);
      expect(hookErrorSpans[0]?.status.code).toBe(SpanStatusCode.ERROR);
      expect(hookErrorSpans[0]?.events[0]?.attributes).toEqual(
        expect.objectContaining({ 'exception.type': 'Error' }),
      );
      expect(hookErrorSpans[0]?.events[0]?.attributes).not.toHaveProperty(
        'exception.message',
      );
      expect(hookErrorSpans[0]?.events[0]?.attributes).not.toHaveProperty(
        'exception.stacktrace',
      );
      expect(hookErrorSpans[0]?.status.message).toBeUndefined();
      expect(hookErrorSpans[0]?.attributes).toEqual(
        expect.objectContaining({
          'http.request.method': 'GET',
          'server.address': 'example.test',
          'url.full': `http://example.test:${portText}/http-error-hook`,
        }),
      );
    });

    it('sanitizes a refused Undici connection', () => {
      const { closedOrigin, undiciErrorSpans } = captured;

      expect(undiciErrorSpans).toHaveLength(1);
      expect(undiciErrorSpans[0]?.status.code).toBe(SpanStatusCode.ERROR);
      expect(undiciErrorSpans[0]?.events[0]?.attributes).toEqual(
        expect.objectContaining({ 'exception.type': 'Error' }),
      );
      expect(undiciErrorSpans[0]?.status.message).toBeUndefined();
      expect(undiciErrorSpans[0]?.attributes).toEqual(
        expect.objectContaining({
          'http.request.method': 'GET',
          'server.address': '127.0.0.1',
          'url.full': `${closedOrigin}/undici-error`,
        }),
      );
    });

    it('uses a safe fallback for a malformed credential-bearing URL', () => {
      const { malformedSpans } = captured;

      expect(malformedSpans).toHaveLength(1);
      expect(malformedSpans[0]?.status.code).toBe(SpanStatusCode.ERROR);
      expect(malformedSpans[0]?.events[0]?.attributes).toEqual(
        expect.objectContaining({ 'exception.type': 'ERR_INVALID_URL' }),
      );
      expect(malformedSpans[0]?.attributes).toEqual(
        expect.objectContaining({
          'http.request.method': 'GET',
          'url.full': 'http://localhost/',
        }),
      );
    });

    it('removes all query and credential sentinels from every exported span', () => {
      const { spans } = captured;
      const secrets = [
        QUERY_SECRET,
        STATE_SECRET,
        ARBITRARY_SECRET,
        ERROR_QUERY_SECRET,
        HOOK_ERROR_QUERY_SECRET,
        FRAGMENT_SECRET,
        MALFORMED_CREDENTIAL_SECRET,
        ERROR_CODE_SECRET,
        MULTI_USERINFO_SECRET,
        SPACED_QUERY_SECRET,
        'user:password@',
      ];

      for (const span of spans) {
        const serializedSpan = JSON.stringify({
          attributes: span.attributes,
          events: span.events,
          instrumentationLibrary: span.instrumentationScope,
          links: span.links,
          name: span.name,
          resource: span.resource.attributes,
          status: span.status,
        });
        for (const secret of secrets) {
          expect(serializedSpan).not.toContain(secret);
        }
        expect(span.attributes['url.query']).toBeUndefined();
      }
    });
  });
});
