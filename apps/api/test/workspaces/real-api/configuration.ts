import { DEFAULT_INSTANCE_LIMITS } from '@pertexo/database/platform';
import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';

import type { ApiConfig } from '../../../src/platform/config/api.js';

import {
  redisUrl,
  publicOrigin,
  invitationKeys,
  databaseConfig,
} from './environment.js';

export function config(): ApiConfig {
  return {
    capacity: DEFAULT_INSTANCE_LIMITS,
    webhookEndpointBurstLimit:
      DEFAULT_INSTANCE_LIMITS.webhookEndpointBurstLimit,
    codeSettings: DEFAULT_CODE_SETTINGS,
    database: databaseConfig,
    host: '127.0.0.1',
    identity: {
      publicWebOrigin: publicOrigin,
      invitationTokenEncryption: invitationKeys,
      session: {
        ttlMillis: 120_000,
        secureCookie: true,
        sameSite: 'lax',
      },
      betterAuth: {
        secret: 'phase1-real-api-integration-secret-with-32-plus-characters',
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
      serviceVersion: 'phase1-integration',
    },
    port: 3000,
    redisUrl,
  };
}
