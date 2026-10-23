import type * as httpTypes from 'node:http';

import {
  SpanStatusCode,
  type Exception,
  type Span,
  type SpanStatus,
} from '@opentelemetry/api';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

import { expect, it } from 'vitest';
import { createNodeInstrumentations } from '../../../src/telemetry/index.js';

export function registerSanitizesExceptionsStatusMessagesThroughConfigured(): void {
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
}
