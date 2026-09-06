import type * as httpTypes from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { node } from '@opentelemetry/sdk-node';
import { describe, expect, it } from 'vitest';

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
  it('sanitizes exported HTTP and Undici spans while retaining safe request data', async () => {
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

    httpInstrumentation.setTracerProvider(provider);
    undiciInstrumentation.setTracerProvider(provider);
    httpInstrumentation.enable();
    undiciInstrumentation.enable();

    const require = createRequire(import.meta.url);
    const http = require('http') as HttpModule;
    const server = http.createServer((request, response) => {
      if (request.url?.startsWith('/undici-client')) {
        response.statusCode = 503;
      }
      response.end('ok');
    });

    try {
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

      const closedServer = http.createServer();
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

      expect(serverSpans).toHaveLength(1);
      expect(httpClientSpans).toHaveLength(1);
      expect(undiciClientSpans).toHaveLength(1);
      expect(httpErrorSpans).toHaveLength(1);
      expect(hookErrorSpans).toHaveLength(1);
      expect(undiciErrorSpans).toHaveLength(1);
      expect(malformedSpans).toHaveLength(1);

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
      expect(undiciClientSpans[0]?.attributes).toEqual(
        expect.objectContaining({
          'http.request.method': 'GET',
          'http.response.status_code': 503,
          'server.address': '127.0.0.1',
          'url.full': `${origin}/undici-client`,
        }),
      );
      expect(httpErrorSpans[0]?.status.code).toBe(SpanStatusCode.ERROR);
      expect(httpErrorSpans[0]?.events[0]?.attributes).toEqual(
        expect.objectContaining({ 'exception.type': 'ECONNREFUSED' }),
      );
      expect(httpErrorSpans[0]?.status.message).toBeUndefined();
      expect(httpErrorSpans[0]?.attributes).toEqual(
        expect.objectContaining({
          'http.request.method': 'GET',
          'server.address': '127.0.0.1',
          'url.full': `${closedOrigin}/http-error`,
        }),
      );
      expect(hookErrorSpans[0]?.status.code).toBe(SpanStatusCode.ERROR);
      expect(hookErrorSpans[0]?.events[0]?.attributes).toEqual(
        expect.objectContaining({
          'exception.type': 'Error',
        }),
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
      expect(undiciErrorSpans[0]?.status.code).toBe(SpanStatusCode.ERROR);
      expect(undiciErrorSpans[0]?.events[0]?.attributes).toEqual(
        expect.objectContaining({ 'exception.type': 'ECONNREFUSED' }),
      );
      expect(undiciErrorSpans[0]?.status.message).toBeUndefined();
      expect(undiciErrorSpans[0]?.attributes).toEqual(
        expect.objectContaining({
          'http.request.method': 'GET',
          'server.address': '127.0.0.1',
          'url.full': `${closedOrigin}/undici-error`,
        }),
      );
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
        expect(serializedSpan).not.toContain(QUERY_SECRET);
        expect(serializedSpan).not.toContain(STATE_SECRET);
        expect(serializedSpan).not.toContain(ARBITRARY_SECRET);
        expect(serializedSpan).not.toContain(ERROR_QUERY_SECRET);
        expect(serializedSpan).not.toContain(HOOK_ERROR_QUERY_SECRET);
        expect(serializedSpan).not.toContain(FRAGMENT_SECRET);
        expect(serializedSpan).not.toContain(MALFORMED_CREDENTIAL_SECRET);
        expect(serializedSpan).not.toContain(ERROR_CODE_SECRET);
        expect(serializedSpan).not.toContain(MULTI_USERINFO_SECRET);
        expect(serializedSpan).not.toContain(SPACED_QUERY_SECRET);
        expect(serializedSpan).not.toContain('user:password@');
      }

      expect(serverSpans[0]?.attributes['url.query']).toBeUndefined();
      expect(httpClientSpans[0]?.attributes['url.query']).toBeUndefined();
      expect(undiciClientSpans[0]?.attributes['url.query']).toBeUndefined();
      expect(httpErrorSpans[0]?.attributes['url.query']).toBeUndefined();
      expect(undiciErrorSpans[0]?.attributes['url.query']).toBeUndefined();
      expect(malformedSpans[0]?.attributes['url.query']).toBeUndefined();
    } finally {
      await close(server);
      httpInstrumentation.disable();
      undiciInstrumentation.disable();
      await provider.shutdown();
    }
  });
});
