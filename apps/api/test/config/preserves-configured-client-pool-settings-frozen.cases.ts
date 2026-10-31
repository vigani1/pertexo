import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';

import { expect, it } from 'vitest';
import { parseApiConfig } from '../../src/platform/config/api.js';
import { validDeployedEnvironment } from './fixture.js';

export function registerPreservesConfiguredClientPoolSettingsFrozen(): void {
  it('preserves configured client pool settings as a frozen record', () => {
    const config = parseApiConfig({
      DATABASE_URL: 'postgresql://app:secret@localhost:5432/pertexo',
      DATABASE_CONNECTION_TIMEOUT_MILLIS: '12345',
      DATABASE_IDLE_TIMEOUT_MILLIS: '60000',
      DATABASE_POOL_MAX: '20',
      POSTGRES_OWNER_USER: 'custom_owner',
    });
    expect(config.database).toEqual({
      connectionString: 'postgresql://app:secret@localhost:5432/pertexo',
      connectionTimeoutMillis: 12_345,
      idleTimeoutMillis: 60_000,
      max: 20,
      ownerRole: 'custom_owner',
    });
    expect(Object.isFrozen(config.database)).toBe(true);
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
      parseApiConfig({
        DATABASE_URL: 'postgresql://app:secret@localhost:5432/pertexo',
        [key]: value,
      }),
    ).toThrow();
  });

  it('enables connection and webhook secrets from the same explicit development key', () => {
    const config = parseApiConfig({
      DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
      CONNECTION_ENCRYPTION_MODE: 'local',
      CONNECTION_LOCAL_KEY: Buffer.alloc(32, 4).toString('base64'),
    });
    expect(config.webhooks).toEqual(config.connections);
    expect(config.webhooks).toMatchObject({ mode: 'self-managed' });
  });

  it.each(['staging', 'production'] as const)(
    'refuses local connection keys in %s',
    (NODE_ENV) => {
      expect(() =>
        parseApiConfig({
          ...validDeployedEnvironment(),
          NODE_ENV,
          CONNECTION_ENCRYPTION_MODE: 'local',
          CONNECTION_LOCAL_KEY: Buffer.alloc(32).toString('base64'),
        }),
      ).toThrow('forbidden when deployed');
    },
  );

  it('enables Better Auth from its secret and public origin', () => {
    const config = parseApiConfig({
      DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
      BETTER_AUTH_SECRET:
        'standalone-better-auth-secret-at-least-32-characters',
      AUTH_MAIL_MODE: 'local',
      PUBLIC_WEB_ORIGIN: 'http://127.0.0.1:5173',
    });

    expect(config.identity).toMatchObject({
      publicWebOrigin: 'http://127.0.0.1:5173',
      betterAuth: { mailMode: 'local' },
      session: { secureCookie: false },
    });
  });

  it('requires a public browser origin for standalone Better Auth', () => {
    expect(() =>
      parseApiConfig({
        DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        BETTER_AUTH_SECRET:
          'standalone-better-auth-secret-at-least-32-characters',
      }),
    ).toThrow('PUBLIC_WEB_ORIGIN is required for Better Auth');
  });

  it('rejects secure browser cookies on an HTTP public origin', () => {
    expect(() =>
      parseApiConfig({
        DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        BETTER_AUTH_SECRET:
          'standalone-better-auth-secret-at-least-32-characters',
        AUTH_MAIL_MODE: 'local',
        PUBLIC_WEB_ORIGIN: 'http://127.0.0.1:5173',
        SESSION_COOKIE_SECURE: 'true',
      }),
    ).toThrow('Secure session cookies require an HTTPS public web origin');
  });

  it('accepts one complete production environment', () => {
    expect(parseApiConfig(validDeployedEnvironment())).toMatchObject({
      nodeEnv: 'production',
      redisUrl: 'rediss://redis.example.test:6380/0',
      trustedProxyCidrs: ['10.0.0.0/8'],
    });
  });

  it('accepts production logs without an optional OTLP exporter', () => {
    const environment = validDeployedEnvironment();
    delete environment.OTEL_EXPORTER_OTLP_ENDPOINT;

    expect(
      parseApiConfig(environment).observability.otlpHttpEndpoint,
    ).toBeUndefined();
  });

  it('rejects deployed proxy omission independently', () => {
    const environment = validDeployedEnvironment();
    delete environment.TRUST_PROXY_CIDRS;

    expect(() => parseApiConfig(environment)).toThrow(
      'TRUST_PROXY_CIDRS is required when deployed',
    );
  });

  it('rejects an invalid IPv6 proxy prefix independently', () => {
    expect(() =>
      parseApiConfig({
        ...validDeployedEnvironment(),
        TRUST_PROXY_CIDRS: '2001:db8::/129',
      }),
    ).toThrow('Invalid proxy IP/CIDR');
  });

  it('rejects an insecure deployed session cookie independently', () => {
    expect(() =>
      parseApiConfig({
        ...validDeployedEnvironment(),
        SESSION_COOKIE_SECURE: 'false',
      }),
    ).toThrow('Secure session cookies are required when deployed');
  });

  it('rejects SameSite=None with an insecure test cookie independently', () => {
    expect(() =>
      parseApiConfig({
        DATABASE_URL: validDeployedEnvironment().DATABASE_URL,
        NODE_ENV: 'test',
        BETTER_AUTH_SECRET:
          'standalone-better-auth-secret-at-least-32-characters',
        PUBLIC_WEB_ORIGIN: 'http://127.0.0.1:5173',
        SESSION_COOKIE_SAME_SITE: 'none',
        SESSION_COOKIE_SECURE: 'false',
      }),
    ).toThrow('SameSite=None requires secure session cookies');
  });

  it('sanitizes malformed previous-key JSON independently', () => {
    expect(() =>
      parseApiConfig({
        ...validDeployedEnvironment(),
        INVITATION_TOKEN_PREVIOUS_KEYS: '{',
      }),
    ).toThrow('Identity configuration is invalid');
  });

  it('uses safe development defaults when optional values are absent', () => {
    const config = parseApiConfig({
      DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
    });

    expect(config).toEqual({
      capacity: {
        activeRunLimit: 20,
        queuedRunLimit: 10_000,
        artifactCountLimit: 10_000,
      },
      webhookEndpointBurstLimit: 600,
      codeSettings: DEFAULT_CODE_SETTINGS,
      database: {
        connectionString:
          'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 5,
        ownerRole: 'pertexo_owner',
      },
      host: '0.0.0.0',
      httpAllowedPrivateNetworks: [],
      nodeEnv: 'development',
      observability: {
        environment: 'development',
        logLevel: 'info',
        otlpHeaders: {},
        serviceName: 'pertexo-api',
        serviceVersion: '0.0.0-dev',
      },
      port: 3000,
      redisUrl: 'redis://localhost:6379/0',
      trustedProxyCidrs: [],
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('rejects Redis URLs without a network host before runtime allocation', () => {
    expect(() =>
      parseApiConfig({
        DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        REDIS_URL: 'redis:///0',
      }),
    ).toThrow('REDIS_URL must use redis:// or rediss:// with a hostname');
  });
}
