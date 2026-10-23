import { SpanKind, SpanStatusCode } from '@opentelemetry/api';

import { expect, it } from 'vitest';

import {
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
} from './fixture.js';

export function registerRetainsSafeServerNodeHTTPClient(): void {
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
}
