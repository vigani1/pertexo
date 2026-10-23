import { expect, it } from 'vitest';

import { createStructuredLogger } from '../../src/logger.js';
import { captureDestination, testConfig } from './fixture.js';

export function registerWritesOneJSONRecordFixedService(): void {
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
      signingKey: 'hmac-signing-value',
      tokenCount: 7,
      xApiKey: 'api-key-value',
    });

    expect(capture.records[0]).toMatchObject({
      authToken: '[Redacted]',
      privateKey: '[Redacted]',
      signing_key: '[Redacted]',
      signingKey: '[Redacted]',
      tokenCount: 7,
      xApiKey: '[Redacted]',
    });
    const serialized = JSON.stringify(capture.records[0]);
    expect(serialized).not.toContain('auth-token-value');
    expect(serialized).not.toContain('private-key-value');
    expect(serialized).not.toContain('signing-key-value');
    expect(serialized).not.toContain('hmac-signing-value');
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

  it('contains top-level and revoked proxy error classification', () => {
    const capture = captureDestination();
    const logger = createStructuredLogger(testConfig(), capture.destination);
    const prototypeTrap = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('prototype trap secret');
        },
      },
    );
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    expect(() => {
      logger.error('error.proxy', {}, prototypeTrap);
    }).not.toThrow();
    expect(() => {
      logger.error('error.revoked', {}, revocable.proxy);
    }).not.toThrow();

    expect(capture.records).toHaveLength(2);
    const serialized = JSON.stringify(capture.records);
    expect(serialized).toContain('[Unserializable error]');
    expect(serialized).not.toContain('prototype trap secret');
  });

  it('checks entry and secret names before reading unknown record values', () => {
    const capture = captureDestination();
    const logger = createStructuredLogger(testConfig(), capture.destination);
    let getterCalls = 0;
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 105; index += 1)
      Object.defineProperty(wide, `field${String(index).padStart(3, '0')}`, {
        enumerable: true,
        get() {
          getterCalls += 1;
          return `value-${String(index)}`;
        },
      });
    Object.defineProperty(wide, 'password', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'secret-getter-value';
      },
    });

    const fields: Record<string, unknown> = { wide };
    Object.defineProperty(fields, 'clientSecret', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'top-level-secret-getter-value';
      },
    });
    logger.info('fields.bounded', fields);

    expect(getterCalls).toBe(0);
    expect(capture.records[0]).toMatchObject({
      wide: { field000: '[Accessor]' },
    });
    const serialized = JSON.stringify(capture.records[0]);
    expect(serialized).not.toContain('secret-getter-value');
    expect(serialized).not.toContain('top-level-secret-getter-value');
    expect(capture.records[0]).toMatchObject({ clientSecret: '[Redacted]' });
    expect(serialized).not.toContain('field104');
  });
}
