import { beforeAll, describe, expect, it } from 'vitest';
import {
  prepareConfiguredHTTPUndiciExportScenariosFixture,
  WEBHOOK_PATH_SECRET,
  WEBHOOK_HEADER_SECRET,
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
  captured,
} from './sanitization-http/fixture.js';
import type * as httpTypes from 'node:http';
import {
  SpanStatusCode,
  SpanKind,
  type Exception,
  type Span,
  type SpanStatus,
} from '@opentelemetry/api';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { createNodeInstrumentations } from '../../src/telemetry/telemetry.runtime.js';

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

  describe('configured HTTP and Undici export scenarios', () => {
    beforeAll(prepareConfiguredHTTPUndiciExportScenariosFixture);
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

    it('exports only redacted webhook paths without named-header or Bearer credentials', () => {
      const webhooks = captured.spans.filter(
        (span) => span.attributes['url.path'] === '/hooks/[Redacted]',
      );
      expect(webhooks).toHaveLength(4);
      expect(
        webhooks.filter((span) => span.kind === SpanKind.SERVER),
      ).toHaveLength(2);
      expect(
        webhooks.filter((span) => span.kind === SpanKind.CLIENT),
      ).toHaveLength(2);
    });

    it('removes all query and credential sentinels from every exported span', () => {
      const { spans } = captured;
      const secrets = [
        WEBHOOK_PATH_SECRET,
        WEBHOOK_HEADER_SECRET,
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
