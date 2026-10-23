import { expect, it } from 'vitest';

import { parseWorkerConfig } from '../../../src/config/worker.js';
import { requiredEnvironment, callbackEnvironment } from './fixture.js';

export function registerPreservesClientDispatcherPoolSettingsOwn(): void {
  it('preserves client and dispatcher pool settings with their own bounds', () => {
    const config = parseWorkerConfig({
      ...requiredEnvironment,
      DATABASE_CONNECTION_TIMEOUT_MILLIS: '12345',
      DATABASE_IDLE_TIMEOUT_MILLIS: '60000',
      DATABASE_POOL_MAX: '20',
      DATABASE_DISPATCHER_POOL_MAX: '10',
    });
    expect(config.database).toEqual({
      connectionString: requiredEnvironment.DATABASE_URL,
      connectionTimeoutMillis: 12_345,
      idleTimeoutMillis: 60_000,
      max: 20,
      ownerRole: 'pertexo_owner',
    });
    expect(config.dispatcherDatabase).toEqual({
      connectionString: requiredEnvironment.DATABASE_MAINTENANCE_URL,
      connectionTimeoutMillis: 12_345,
      idleTimeoutMillis: 60_000,
      max: 10,
      ownerRole: 'pertexo_owner',
    });
    expect(Object.isFrozen(config.database)).toBe(true);
    expect(Object.isFrozen(config.dispatcherDatabase)).toBe(true);
  });

  it.each([
    ['DATABASE_POOL_MAX', '0'],
    ['DATABASE_POOL_MAX', '21'],
    ['DATABASE_POOL_MAX', '2.5'],
    ['DATABASE_CONNECTION_TIMEOUT_MILLIS', '0'],
    ['DATABASE_CONNECTION_TIMEOUT_MILLIS', 'bad'],
    ['DATABASE_IDLE_TIMEOUT_MILLIS', '-1'],
    ['DATABASE_IDLE_TIMEOUT_MILLIS', '1.5'],
  ])('refuses invalid %s=%s at the config boundary', (key, value) => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        [key]: value,
      }),
    ).toThrow('Invalid worker configuration');
  });

  it('enables the shared local provider only outside deployed environments', () => {
    const local = {
      ...requiredEnvironment,
      CONNECTION_ENCRYPTION_MODE: 'local',
      CONNECTION_LOCAL_KEY: Buffer.alloc(32).toString('base64'),
    };
    expect(parseWorkerConfig(local).connectionEncryption).toMatchObject({
      mode: 'self-managed',
    });
    for (const NODE_ENV of ['staging', 'production']) {
      expect(() =>
        parseWorkerConfig({
          ...local,
          NODE_ENV,
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://telemetry.example.test',
        }),
      ).toThrow('Invalid worker configuration');
    }
  });

  it('parses the dedicated authentication-mail worker configuration', () => {
    expect(
      parseWorkerConfig({
        ...requiredEnvironment,
        WORKER_INSTANCE_ID: 'mail-worker-1',
        AUTH_MAIL_EMAIL_API_KEY: 'provider-key',
        AUTH_MAIL_KEY: Buffer.alloc(32, 4).toString('base64'),
        AUTH_MAIL_KEY_VERSION: 'mail-v1',
        AUTH_MAIL_FROM: 'security@example.test',
        PUBLIC_WEB_ORIGIN: 'https://app.example.test',
      }).systemMailDelivery,
    ).toMatchObject({
      delivery: { mode: 'resend', apiKey: 'provider-key' },
      timeoutMillis: 5_000,
      pollIntervalMillis: 1_000,
      workerId: 'auth-mail:mail-worker-1',
      encryption: { current: { version: 'mail-v1' } },
    });
  });

  it('fails closed when authentication-mail delivery is partially configured', () => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        AUTH_MAIL_EMAIL_API_KEY: 'provider-key',
      }),
    ).toThrow('Invalid worker configuration');
  });

  it('requires authentication-mail delivery in a deployed worker', () => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        ...callbackEnvironment,
        NODE_ENV: 'production',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://telemetry.example.test/v1',
      }),
    ).toThrow('Invalid worker configuration');
  });

  it('reads the HTTP request private-network allowlist and refuses a malformed one', () => {
    expect(
      parseWorkerConfig({
        ...requiredEnvironment,
        HTTP_ALLOWED_PRIVATE_NETWORKS: '10.0.0.0/8',
      }).httpRequest.allowedPrivateNetworks,
    ).toHaveLength(1);
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        HTTP_ALLOWED_PRIVATE_NETWORKS: '10.0.0.0',
      }),
    ).toThrow('Invalid worker configuration');
  });
}
