import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';

import { expect, it } from 'vitest';
import { parseApiConfig } from '../../src/platform/config/api.js';
import { validDeployedEnvironment } from './fixture.js';

export function registerParsesValidEnvironmentValuesIntoTyped(): void {
  it('parses valid environment values into the typed public config', () => {
    const config = parseApiConfig({
      DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      PORT: '4312',
      POSTGRES_APP_USER: 'custom_worker',
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
      host: '127.0.0.1',
      httpAllowedPrivateNetworks: [],
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
      trustedProxyCidrs: [],
    });
  });

  it('parses an optional complete artifact configuration locally', () => {
    const config = parseApiConfig({
      DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
      ARTIFACT_STORE_ACCESS_KEY_ID: 'primary-key',
      ARTIFACT_STORE_SECRET_ACCESS_KEY: 'primary-secret',
      ARTIFACT_STORE_BUCKET: 'pertexo-primary',
      ARTIFACT_STORE_ENDPOINT: 'http://localhost:19090',
      ARTIFACT_STORE_FORCE_PATH_STYLE: 'true',
      ARTIFACT_STORE_REGION: 'primary',
      ARTIFACT_MAX_BYTES: '2048',
    });
    expect(config.artifacts?.maxObjectBytes).toBe(2048);
  });

  it('rejects partial artifact configuration without exposing credentials', () => {
    expect(() =>
      parseApiConfig({
        DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        ARTIFACT_STORE_ACCESS_KEY_ID: 'sensitive-access-key',
      }),
    ).toThrow('Artifact store configuration is incomplete');
  });

  it('requires identity configuration in a deployed environment', () => {
    expect(() =>
      parseApiConfig({
        DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        NODE_ENV: 'staging',
      }),
    ).toThrow('Better Auth configuration is incomplete');
  });

  it('parses and freezes complete identity configuration', () => {
    const config = parseApiConfig({
      ...validDeployedEnvironment(),
      NODE_ENV: 'staging',
      CONNECTION_KMS_KEY_REFERENCE:
        'arn:aws:kms:eu-central-1:123456789012:key/example',
      TRUST_PROXY_CIDRS: '10.0.0.0/8, 2001:db8::/32',
    });

    expect(config.identity).toMatchObject({
      publicWebOrigin: 'https://app.example.test',
      invitationTokenEncryption: { current: { version: 'invite-v1' } },
      session: {
        secureCookie: true,
        sameSite: 'lax',
      },
      betterAuth: { mailMode: 'durable' },
    });
    expect(Object.isFrozen(config.identity)).toBe(true);
    expect(config.connections).toEqual({
      kmsKeyReference: 'arn:aws:kms:eu-central-1:123456789012:key/example',
      region: 'eu-central-1',
    });
    expect(Object.isFrozen(config.connections)).toBe(true);
    expect(config.webhooks).toEqual(config.connections);
    expect(Object.isFrozen(config.webhooks)).toBe(true);
    expect(config.artifacts).toMatchObject({
      bucket: 'pertexo-primary',
      region: 'eu-central-1',
      maxObjectBytes: 10 * 1024 * 1024,
    });
    expect(Object.isFrozen(config.artifacts)).toBe(true);
  });

  it('rejects partial provider configuration without exposing its secret', () => {
    const secret = 'should-never-appear';
    let message = '';
    try {
      parseApiConfig({
        DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        BETTER_AUTH_SECRET:
          'standalone-better-auth-secret-at-least-32-characters',
        PUBLIC_WEB_ORIGIN: 'http://127.0.0.1:5173',
        AUTH_GOOGLE_CLIENT_SECRET: secret,
      });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Identity configuration is invalid');
    expect(message).not.toContain(secret);
  });

  it('rejects a port outside the TCP port range', () => {
    expect(() =>
      parseApiConfig({
        DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        PORT: '70000',
      }),
    ).toThrow();
  });

  it('accepts only explicit trusted proxy IP and CIDR networks', () => {
    expect(
      parseApiConfig({
        DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        TRUST_PROXY_CIDRS: '127.0.0.1, 10.0.0.0/8, 2001:db8::/32',
      }).trustedProxyCidrs,
    ).toEqual(['127.0.0.1', '10.0.0.0/8', '2001:db8::/32']);
    expect(() =>
      parseApiConfig({
        DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        TRUST_PROXY_CIDRS: '10.0.0.0/99',
      }),
    ).toThrow();
  });

  it('requires a Redis event-hint endpoint when deployed', () => {
    expect(() =>
      parseApiConfig({
        DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        NODE_ENV: 'staging',
        PUBLIC_WEB_ORIGIN: 'https://app.example.test',
        BETTER_AUTH_SECRET: 'better-auth-staging-secret-at-least-32-characters',
        AUTH_MAIL_MODE: 'durable',
        AUTH_MAIL_FROM: 'security@example.test',
        AUTH_MAIL_KEY: Buffer.alloc(32, 9).toString('base64'),
        AUTH_MAIL_KEY_VERSION: 'auth-mail-v1',
        INVITATION_TOKEN_KEY: Buffer.alloc(32, 8).toString('base64'),
        INVITATION_TOKEN_KEY_VERSION: 'invite-v1',
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
        DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
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
        DATABASE_URL: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        NODE_ENV: 'production',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.test',
        PUBLIC_WEB_ORIGIN: 'https://app.example.test',
        BETTER_AUTH_SECRET:
          'better-auth-production-secret-at-least-32-characters',
        AUTH_MAIL_MODE: 'durable',
        AUTH_MAIL_FROM: 'security@example.test',
        AUTH_MAIL_KEY: Buffer.alloc(32, 9).toString('base64'),
        AUTH_MAIL_KEY_VERSION: 'auth-mail-v1',
        CONNECTION_KMS_KEY_REFERENCE: 'alias/pertexo-connections',
        INVITATION_TOKEN_KEY: Buffer.alloc(32, 8).toString('base64'),
        INVITATION_TOKEN_KEY_VERSION: 'invite-v1',
        CONNECTION_KMS_REGION: 'eu-central-1',
        CONNECTION_KMS_ENDPOINT: 'http://kms.example.test',
        REDIS_URL: 'rediss://redis.example.test:6380/0',
      }),
    ).toThrow('HTTPS connection KMS endpoint is required when deployed');
  });
}
