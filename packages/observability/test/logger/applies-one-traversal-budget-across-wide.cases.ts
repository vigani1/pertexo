import { context, TraceFlags, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

import { expect, it } from 'vitest';

import { createStructuredLogger } from '../../src/logger.js';
import { captureDestination, testConfig } from './fixture.js';

export function registerAppliesOneTraversalBudgetAcrossWide(): void {
  it('applies one traversal budget across wide nested records', () => {
    const capture = captureDestination();
    const logger = createStructuredLogger(testConfig(), capture.destination);
    const fields = Object.fromEntries(
      Array.from({ length: 100 }, (_, outer) => [
        `outer${String(outer)}`,
        Object.fromEntries(
          Array.from({ length: 100 }, (_, inner) => [
            `inner${String(inner)}`,
            inner,
          ]),
        ),
      ]),
    );

    logger.info('fields.total_bound', fields);

    expect(JSON.stringify(capture.records[0]).length).toBeLessThan(15_000);
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

  it('redacts and bounds error names at every cause depth', () => {
    const capture = captureDestination();
    const logger = createStructuredLogger(testConfig(), capture.destination);
    const cause = new Error('nested failure');
    cause.name = `NestedError token=nested-name-secret ${'x'.repeat(20_000)}`;
    const error = new Error('provider failure', { cause });
    error.name = 'ProviderError token=top-level-name-secret';

    logger.error('provider.failed', {}, error);

    const serialized = JSON.stringify(capture.records[0]);
    expect(serialized).not.toContain('top-level-name-secret');
    expect(serialized).not.toContain('nested-name-secret');
    expect(serialized).toContain('[Redacted]');
    expect(serialized).toContain('[Truncated]');
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
}
