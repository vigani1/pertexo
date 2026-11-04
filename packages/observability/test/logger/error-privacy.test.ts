import { expect, it } from 'vitest';
import { createStructuredLogger } from '../../src/logger.js';
import { captureDestination, testConfig } from './fixture.js';

it('keeps arbitrary error text private while retaining structured operator context', () => {
  const capture = captureDestination();
  const logger = createStructuredLogger(testConfig(), capture.destination);
  const text =
    'https://user:password@service.test/reset/path-secret/person@example.test?code=query-secret plain-private-text';
  const error = new Error(text, { cause: new Error(text) });
  error.name = 'path-secret';
  error.stack = text;
  for (const thrown of [error, text, { reason: text }])
    logger.error(
      'operation.failed',
      {
        method: 'POST',
        status: 502,
        host: 'service.test',
        operation: 'delivery.send',
      },
      thrown,
    );
  expect(capture.records).toHaveLength(3);
  for (const record of capture.records) {
    const serialized = JSON.stringify(record);
    for (const secret of [
      'path-secret',
      'person@example.test',
      'query-secret',
      'plain-private-text',
      'user:password',
    ])
      expect(serialized).not.toContain(secret);
    expect(record).toMatchObject({
      event: 'operation.failed',
      method: 'POST',
      status: 502,
      host: 'service.test',
      operation: 'delivery.send',
      serviceName: 'api',
    });
  }
});

it('keeps Nest string errors, optional stacks and contexts out of log text', async () => {
  const { NestLoggerAdapter } = await import('../../src/nest-runtime.js');
  const capture = captureDestination();
  const adapter = new NestLoggerAdapter(
    createStructuredLogger(testConfig(), capture.destination),
  );
  for (const level of ['error', 'fatal'] as const)
    adapter[level](
      'plain-private-text person@example.test /reset/path-secret',
      'Error: query-secret\n    at /private/path-secret',
      'path-secret',
    );
  for (const record of capture.records) {
    for (const secret of [
      'plain-private-text',
      'person@example.test',
      'path-secret',
      'query-secret',
    ])
      expect(JSON.stringify(record)).not.toContain(secret);
    expect(record).toMatchObject({ serviceName: 'api', messageType: 'string' });
  }
});

it('retains a known machine error code while refusing arbitrary error codes and text', () => {
  const capture = captureDestination();
  const logger = createStructuredLogger(testConfig(), capture.destination);
  for (const code of ['ECONNREFUSED', 'person@example.test', 'path-secret'])
    logger.error(
      'connection.failed',
      {},
      Object.assign(new Error('plain-private-text'), { code }),
    );
  expect(capture.records[0]).toMatchObject({
    err: { code: 'ECONNREFUSED', message: '[Redacted]' },
  });
  expect(JSON.stringify(capture.records)).not.toContain('person@example.test');
  expect(JSON.stringify(capture.records)).not.toContain('path-secret');
  expect(JSON.stringify(capture.records)).not.toContain('plain-private-text');
});
