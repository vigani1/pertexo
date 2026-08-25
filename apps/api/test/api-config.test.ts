import { describe, expect, it } from 'vitest';

import { parseApiConfig } from '../src/platform/config/api-config.js';

describe('parseApiConfig', () => {
  it.each(['for_each_staging', 'for_each_activation'] as const)(
    'accepts the %s compatibility cohort',
    (cohort) => {
      expect(
        parseApiConfig({
          DATABASE_API_URL:
            'postgresql://pertexo_api:secret@localhost:5432/pertexo',
          NODE_COMPATIBILITY_COHORT: cohort,
        }).nodeCompatibilityCohort,
      ).toBe(cohort);
    },
  );

  it('uses safe development defaults when optional values are absent', () => {
    const config = parseApiConfig({
      DATABASE_API_URL:
        'postgresql://pertexo_api:secret@localhost:5432/pertexo',
    });

    expect(config).toEqual({
      database: {
        connectionString:
          'postgresql://pertexo_api:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 5,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      },
      host: '0.0.0.0',
      nodeCompatibilityCohort: 'core',
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
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('parses valid environment values into the typed public config', () => {
    const config = parseApiConfig({
      DATABASE_API_URL:
        'postgresql://pertexo_api:secret@localhost:5432/pertexo',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      NODE_COMPATIBILITY_COHORT: 'http_staging',
      PORT: '4312',
      POSTGRES_WORKER_RUNTIME_USER: 'custom_worker',
    });

    expect(config).toEqual({
      database: {
        connectionString:
          'postgresql://pertexo_api:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 5,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'custom_worker',
      },
      host: '127.0.0.1',
      nodeCompatibilityCohort: 'http_staging',
      nodeEnv: 'test',
      observability: {
        environment: 'test',
        logLevel: 'info',
        otlpHeaders: {},
        serviceName: 'pertexo-api',
        serviceVersion: '0.0.0-dev',
      },
      port: 4312,
      redisUrl: 'redis://localhost:6379/0',
    });
  });

  it('requires identity configuration in a deployed environment', () => {
    expect(() =>
      parseApiConfig({
        DATABASE_API_URL:
          'postgresql://pertexo_api:secret@localhost:5432/pertexo',
        NODE_ENV: 'staging',
      }),
    ).toThrow('Identity configuration is incomplete');
  });

  it('parses and freezes complete identity configuration', () => {
    const config = parseApiConfig({
      DATABASE_API_URL:
        'postgresql://pertexo_api:secret@localhost:5432/pertexo',
      NODE_ENV: 'staging',
      OIDC_ISSUER: 'https://identity.example.test',
      OIDC_AUTHORIZATION_ENDPOINT:
        'https://identity.example.test/oauth2/authorize',
      OIDC_TOKEN_ENDPOINT: 'https://identity.example.test/oauth2/token',
      OIDC_JWKS_URI: 'https://identity.example.test/.well-known/jwks.json',
      OIDC_CLIENT_ID: 'pertexo-api',
      OIDC_CLIENT_SECRET: 'provider-secret',
      OIDC_REDIRECT_URI: 'https://api.example.test/v1/auth/oidc/callback',
      OIDC_ALLOWED_ALGORITHMS: 'RS256,ES256',
      OIDC_TRANSACTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      OIDC_TRANSACTION_KEY_VERSION: 'v2',
      OIDC_TRANSACTION_PREVIOUS_KEYS: JSON.stringify([
        { version: 'v1', key: Buffer.alloc(32, 6).toString('base64') },
      ]),
      CONNECTION_KMS_KEY_REFERENCE:
        'arn:aws:kms:eu-central-1:123456789012:key/example',
      CONNECTION_KMS_REGION: 'eu-central-1',
      REDIS_URL: 'rediss://redis.example.test:6380/0',
    });

    expect(config.identity).toMatchObject({
      oidc: {
        issuer: 'https://identity.example.test',
        clientId: 'pertexo-api',
        scopes: ['openid', 'profile', 'email'],
        allowedAlgorithms: ['RS256', 'ES256'],
        allowInsecureHttpForTests: false,
      },
      secretEncryption: {
        current: { version: 'v2' },
        previous: [{ version: 'v1' }],
      },
      session: {
        secureCookie: true,
        sameSite: 'lax',
      },
    });
    expect(Object.isFrozen(config.identity)).toBe(true);
    expect(Object.isFrozen(config.identity?.oidc.scopes)).toBe(true);
    expect(config.connections).toEqual({
      kmsKeyReference: 'arn:aws:kms:eu-central-1:123456789012:key/example',
      region: 'eu-central-1',
    });
    expect(Object.isFrozen(config.connections)).toBe(true);
    expect(config.webhooks).toEqual(config.connections);
    expect(Object.isFrozen(config.webhooks)).toBe(true);
  });

  it('rejects partial local identity configuration without exposing its secret', () => {
    const secret = 'should-never-appear';
    let message = '';
    try {
      parseApiConfig({
        DATABASE_API_URL:
          'postgresql://pertexo_api:secret@localhost:5432/pertexo',
        OIDC_CLIENT_SECRET: secret,
      });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Identity configuration is incomplete');
    expect(message).not.toContain(secret);
  });

  it('permits insecure OIDC endpoints only in the test environment', () => {
    const config = parseApiConfig({
      DATABASE_API_URL:
        'postgresql://pertexo_api:secret@localhost:5432/pertexo',
      NODE_ENV: 'test',
      OIDC_ISSUER: 'http://127.0.0.1:4400',
      OIDC_AUTHORIZATION_ENDPOINT: 'http://127.0.0.1:4400/authorize',
      OIDC_TOKEN_ENDPOINT: 'http://127.0.0.1:4400/token',
      OIDC_JWKS_URI: 'http://127.0.0.1:4400/jwks',
      OIDC_CLIENT_ID: 'integration-test',
      OIDC_REDIRECT_URI: 'http://127.0.0.1:3000/v1/auth/oidc/callback',
      OIDC_TRANSACTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      OIDC_TRANSACTION_KEY_VERSION: 'test-v1',
      SESSION_COOKIE_SECURE: 'false',
    });

    expect(config.identity?.oidc.allowInsecureHttpForTests).toBe(true);
  });

  it('rejects insecure identity endpoints in a deployed environment', () => {
    expect(() =>
      parseApiConfig({
        DATABASE_API_URL:
          'postgresql://pertexo_api:secret@localhost:5432/pertexo',
        NODE_ENV: 'production',
        OIDC_ISSUER: 'http://identity.example.test',
        OIDC_AUTHORIZATION_ENDPOINT: 'https://identity.example.test/authorize',
        OIDC_TOKEN_ENDPOINT: 'https://identity.example.test/token',
        OIDC_JWKS_URI: 'https://identity.example.test/jwks',
        OIDC_CLIENT_ID: 'pertexo-api',
        OIDC_REDIRECT_URI: 'https://api.example.test/v1/auth/oidc/callback',
        OIDC_TRANSACTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        OIDC_TRANSACTION_KEY_VERSION: 'v1',
      }),
    ).toThrow('HTTPS identity endpoints are required when deployed');
  });

  it('rejects a port outside the TCP port range', () => {
    expect(() =>
      parseApiConfig({
        DATABASE_API_URL:
          'postgresql://pertexo_api:secret@localhost:5432/pertexo',
        PORT: '70000',
      }),
    ).toThrow();
  });

  it('requires a Redis event-hint endpoint when deployed', () => {
    expect(() =>
      parseApiConfig({
        DATABASE_API_URL:
          'postgresql://pertexo_api:secret@localhost:5432/pertexo',
        NODE_ENV: 'staging',
        OIDC_ISSUER: 'https://identity.example.test',
        OIDC_AUTHORIZATION_ENDPOINT:
          'https://identity.example.test/oauth2/authorize',
        OIDC_TOKEN_ENDPOINT: 'https://identity.example.test/oauth2/token',
        OIDC_JWKS_URI: 'https://identity.example.test/.well-known/jwks.json',
        OIDC_CLIENT_ID: 'pertexo-api',
        OIDC_REDIRECT_URI: 'https://api.example.test/v1/auth/oidc/callback',
        OIDC_TRANSACTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        OIDC_TRANSACTION_KEY_VERSION: 'v1',
        CONNECTION_KMS_KEY_REFERENCE:
          'arn:aws:kms:eu-central-1:123456789012:key/example',
        CONNECTION_KMS_REGION: 'eu-central-1',
      }),
    ).toThrow('REDIS_URL is required when deployed');
  });

  it('rejects partial connection KMS configuration without exposing the key reference', () => {
    const keyReference = 'should-never-appear';
    let message = '';
    try {
      parseApiConfig({
        DATABASE_API_URL:
          'postgresql://pertexo_api:secret@localhost:5432/pertexo',
        CONNECTION_KMS_KEY_REFERENCE: keyReference,
      });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Connection KMS configuration is incomplete');
    expect(message).not.toContain(keyReference);
  });

  it('rejects an insecure deployed connection KMS endpoint', () => {
    expect(() =>
      parseApiConfig({
        DATABASE_API_URL:
          'postgresql://pertexo_api:secret@localhost:5432/pertexo',
        NODE_ENV: 'production',
        OIDC_ISSUER: 'https://identity.example.test',
        OIDC_AUTHORIZATION_ENDPOINT: 'https://identity.example.test/authorize',
        OIDC_TOKEN_ENDPOINT: 'https://identity.example.test/token',
        OIDC_JWKS_URI: 'https://identity.example.test/jwks',
        OIDC_CLIENT_ID: 'pertexo-api',
        OIDC_REDIRECT_URI: 'https://api.example.test/v1/auth/oidc/callback',
        OIDC_TRANSACTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        OIDC_TRANSACTION_KEY_VERSION: 'v1',
        CONNECTION_KMS_KEY_REFERENCE: 'alias/pertexo-connections',
        CONNECTION_KMS_REGION: 'eu-central-1',
        CONNECTION_KMS_ENDPOINT: 'http://kms.example.test',
        REDIS_URL: 'rediss://redis.example.test:6380/0',
      }),
    ).toThrow('HTTPS connection KMS endpoint is required when deployed');
  });
});
