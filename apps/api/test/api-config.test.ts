import { describe, expect, it } from 'vitest';

import { parseApiConfig } from '../src/platform/config/api-config.js';

describe('parseApiConfig', () => {
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
      },
      host: '0.0.0.0',
      nodeEnv: 'development',
      observability: {
        environment: 'development',
        logLevel: 'info',
        otlpHeaders: {},
        serviceName: 'pertexo-api',
        serviceVersion: '0.0.0-dev',
      },
      port: 3000,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('parses valid environment values into the typed public config', () => {
    const config = parseApiConfig({
      DATABASE_API_URL:
        'postgresql://pertexo_api:secret@localhost:5432/pertexo',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      PORT: '4312',
    });

    expect(config).toEqual({
      database: {
        connectionString:
          'postgresql://pertexo_api:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 5,
        ownerRole: 'pertexo_owner',
      },
      host: '127.0.0.1',
      nodeEnv: 'test',
      observability: {
        environment: 'test',
        logLevel: 'info',
        otlpHeaders: {},
        serviceName: 'pertexo-api',
        serviceVersion: '0.0.0-dev',
      },
      port: 4312,
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
});
