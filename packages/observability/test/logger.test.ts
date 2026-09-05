import { context, TraceFlags, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import type { DestinationStream } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { parseObservabilityConfig } from '../src/config.js';
import { createStructuredLogger } from '../src/logger.js';

function captureDestination(): {
  destination: DestinationStream;
  records: Record<string, unknown>[];
} {
  const records: Record<string, unknown>[] = [];
  return {
    destination: {
      write(message: string): void {
        records.push(JSON.parse(message) as Record<string, unknown>);
      },
    },
    records,
  };
}

function testConfig() {
  return parseObservabilityConfig({
    environment: 'test',
    logLevel: 'trace',
    serviceName: 'api',
    serviceVersion: '1.2.3',
  });
}

afterEach(() => {
  context.disable();
});

describe('createStructuredLogger', () => {
  it('writes one JSON record with fixed service and event keys', () => {
    const capture = captureDestination();
    const logger = createStructuredLogger(testConfig(), capture.destination);

    logger.info('request.completed', {
      event: 'caller.override',
      requestId: 'request-1',
      serviceName: 'caller-service',
    });

    expect(capture.records).toHaveLength(1);
    expect(capture.records[0]).toMatchObject({
      environment: 'test',
      event: 'request.completed',
      level: 30,
      msg: 'request.completed',
      requestId: 'request-1',
      serviceName: 'api',
      serviceVersion: '1.2.3',
    });
  });

  it('replaces a dynamic unsafe event name instead of logging it', () => {
    const capture = captureDestination();
    const logger = createStructuredLogger(testConfig(), capture.destination);

    logger.warn('provider.failed token=event-secret');

    expect(capture.records[0]).toMatchObject({
      event: 'log.invalid_event',
      msg: 'log.invalid_event',
    });
    expect(JSON.stringify(capture.records[0])).not.toContain('event-secret');
  });

  it('redacts likely secret paths at multiple nesting levels', () => {
    const capture = captureDestination();
    const logger = createStructuredLogger(testConfig(), capture.destination);

    logger.info('provider.called', {
      apiKey: 'top-level-key',
      connection: {
        clientSecret: 'oauth-client-secret',
        deeply: {
          nested: {
            provider: { credentials: { password: 'nested-password' } },
          },
        },
      },
      request: {
        headers: {
          authorization: 'Bearer token',
          cookie: 'session=secret',
          'set-cookie': 'session=new-secret',
        },
      },
      refreshToken: 'refresh-token',
      token: 'top-level-token',
    });

    expect(capture.records[0]).toMatchObject({
      apiKey: '[Redacted]',
      connection: {
        clientSecret: '[Redacted]',
        deeply: {
          nested: {
            provider: { credentials: { password: '[Redacted]' } },
          },
        },
      },
      request: {
        headers: {
          authorization: '[Redacted]',
          cookie: '[Redacted]',
          'set-cookie': '[Redacted]',
        },
      },
      refreshToken: '[Redacted]',
      token: '[Redacted]',
    });
    expect(JSON.stringify(capture.records[0])).not.toContain('nested-password');
  });

  it('redacts common key and token variants without hiding ordinary counters', () => {
    const capture = captureDestination();
    const logger = createStructuredLogger(testConfig(), capture.destination);

    logger.info('provider.called', {
      authToken: 'auth-token-value',
      privateKey: 'private-key-value',
      signing_key: 'signing-key-value',
      tokenCount: 7,
      xApiKey: 'api-key-value',
    });

    expect(capture.records[0]).toMatchObject({
      authToken: '[Redacted]',
      privateKey: '[Redacted]',
      signing_key: '[Redacted]',
      tokenCount: 7,
      xApiKey: '[Redacted]',
    });
    const serialized = JSON.stringify(capture.records[0]);
    expect(serialized).not.toContain('auth-token-value');
    expect(serialized).not.toContain('private-key-value');
    expect(serialized).not.toContain('signing-key-value');
    expect(serialized).not.toContain('api-key-value');
  });

  it('never lets hostile fields or error properties escape into business code', () => {
    const capture = captureDestination();
    const logger = createStructuredLogger(testConfig(), capture.destination);
    const hostileFields = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('field trap secret');
        },
      },
    );
    const hostileError = new Error('safe');
    Object.defineProperty(hostileError, 'message', {
      get: () => {
        throw new Error('error trap secret');
      },
    });

    expect(() => {
      logger.info('fields.hostile', hostileFields);
    }).not.toThrow();
    expect(() => {
      logger.error('error.hostile', {}, hostileError);
    }).not.toThrow();
    expect(capture.records).toHaveLength(2);
    expect(JSON.stringify(capture.records)).not.toContain('trap secret');
  });

  it('serializes errors with their causes', () => {
    const capture = captureDestination();
    const logger = createStructuredLogger(testConfig(), capture.destination);
    const cause = new Error('database unavailable');

    logger.error(
      'request.failed',
      { requestId: 'request-2' },
      new Error('request aborted', { cause }),
    );

    expect(capture.records[0]).toMatchObject({
      err: {
        cause: { message: 'database unavailable', type: 'Error' },
        message: 'request aborted',
        type: 'Error',
      },
      event: 'request.failed',
    });
  });

  it('redacts credentials embedded in error messages, stacks, and causes', () => {
    const capture = captureDestination();
    const logger = createStructuredLogger(testConfig(), capture.destination);
    const cause = new Error(
      [
        'connection postgresql://runtime:database-password@db.example.test/app failed',
        'Authorization: Basic dXNlcjpwYXNzd29yZA==',
        'Cookie: session=cookie-secret; preference=dark',
        'Set-Cookie: refresh=set-cookie-secret; HttpOnly',
        'credentials=plural-credential-secret',
      ].join('\n'),
    );
    const error = new Error('provider failed token=provider-token', { cause });

    logger.error('provider.failed', {}, error);

    const serialized = JSON.stringify(capture.records[0]);
    expect(serialized).not.toContain('database-password');
    expect(serialized).not.toContain('provider-token');
    expect(serialized).not.toContain('dXNlcjpwYXNzd29yZA');
    expect(serialized).not.toContain('cookie-secret');
    expect(serialized).not.toContain('set-cookie-secret');
    expect(serialized).not.toContain('plural-credential-secret');
    expect(serialized).toContain('[Redacted]');
    expect(capture.records[0]).toMatchObject({
      err: {
        cause: { type: 'Error' },
        type: 'Error',
      },
    });
  });

  it('bounds adversarial redaction input before scanning secret patterns', () => {
    const capture = captureDestination();
    const logger = createStructuredLogger(testConfig(), capture.destination);
    const secretPrefix = 'postgresql://runtime:';
    const adversarial = `${'context '.repeat(2_100)}${secretPrefix}${'a'.repeat(100_000)}!`;
    const startedAt = performance.now();

    logger.warn('provider.failed', { detail: adversarial });

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    const serialized = JSON.stringify(capture.records[0]);
    expect(serialized.length).toBeLessThan(20_000);
    expect(serialized).toContain('[Truncated]');
    expect(serialized).not.toContain(secretPrefix);
  });

  it('applies the same text bound to error messages and stacks', () => {
    const capture = captureDestination();
    const logger = createStructuredLogger(testConfig(), capture.destination);
    const oversized = `${'safe context '.repeat(2_000)}Bearer secret-after-boundary`;
    const error = new Error(oversized);
    error.stack = oversized;

    logger.error('provider.failed', {}, error);

    const serialized = JSON.stringify(capture.records[0]);
    expect(serialized).toContain('[Truncated]');
    expect(serialized).not.toContain('secret-after-boundary');
    expect(serialized.length).toBeLessThan(40_000);
  });

  it('correlates records with the active valid span', () => {
    const manager = new AsyncLocalStorageContextManager().enable();
    expect(context.setGlobalContextManager(manager)).toBe(true);
    const capture = captureDestination();
    const logger = createStructuredLogger(testConfig(), capture.destination);
    const spanContext = {
      spanId: '1234567890abcdef',
      traceFlags: TraceFlags.SAMPLED,
      traceId: '1234567890abcdef1234567890abcdef',
    };

    context.with(
      trace.setSpan(context.active(), trace.wrapSpanContext(spanContext)),
      () => {
        logger.info('span.correlated');
      },
    );

    expect(capture.records[0]).toMatchObject({
      spanId: spanContext.spanId,
      traceId: spanContext.traceId,
    });
    manager.disable();
  });
});
