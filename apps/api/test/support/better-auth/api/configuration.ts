import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';
import type { ApiIdentityConfig } from '../../../../src/platform/config/identity.js';

import type { DatabaseConfig } from '@pertexo/database/testing';

import type { ApiConfig } from '../../../../src/platform/config/api.js';

import { redisUrl, origin, invitationKeys } from './environment.js';
import type { ApiFixtureOptions } from './contract.js';

export function apiConfig(database: DatabaseConfig): ApiConfig {
  return {
    codeSettings: DEFAULT_CODE_SETTINGS,
    database,
    host: '127.0.0.1',
    identity: {
      publicWebOrigin: origin,
      invitationTokenEncryption: invitationKeys,
      session: { ttlMillis: 3_600_000, secureCookie: false, sameSite: 'lax' },
      betterAuth: {
        secret: 'better-auth-only-integration-secret-with-32-plus-characters',
        mailMode: 'local',
        signUpMode: 'open',
        providers: {},
      },
    },
    nodeEnv: 'test',
    observability: {
      environment: 'test',
      logLevel: 'silent',
      otlpHeaders: {},
      serviceName: 'pertexo-api',
      serviceVersion: 'better-auth-integration',
    },
    port: 3000,
    redisUrl,
  };
}

export function fixtureIdentityConfiguration(
  defaults: ApiIdentityConfig,
  options: ApiFixtureOptions,
  fixtureOrigin: string,
): ApiIdentityConfig {
  return {
    ...defaults,
    publicWebOrigin: fixtureOrigin,
    session: {
      ...defaults.session,
      secureCookie: options.secureCookies ?? defaults.session.secureCookie,
    },
    ...(options.federationEncryption === undefined
      ? {}
      : { federationEncryption: options.federationEncryption }),
    automationTokensEnabled: options.automationTokens ?? false,
    betterAuth: {
      ...defaults.betterAuth,
      // Most tests sign several people up; closed sign-up has its own tests.
      signUpMode: options.signUpMode ?? 'open',
      providers: options.socialProviders ?? defaults.betterAuth.providers,
    },
  };
}

export function fixtureApiConfiguration(
  defaults: ApiConfig,
  identity: ApiIdentityConfig,
  options: ApiFixtureOptions,
): ApiConfig {
  return {
    ...defaults,
    ...(options.callbacks === undefined
      ? {}
      : { callbacks: options.callbacks }),
    identity,
    redisUrl: options.redisUrl ?? redisUrl,
    ...(options.artifacts === undefined
      ? {}
      : { artifacts: options.artifacts }),
    ...(options.connections === undefined
      ? {}
      : { connections: options.connections.config }),
  };
}
