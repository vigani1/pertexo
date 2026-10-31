import { DEFAULT_INSTANCE_LIMITS } from '@pertexo/database/platform';
import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';

import type { ArtifactStoreConfig } from '@pertexo/artifact-store';

import type { ApiConfig } from '../../../src/platform/config/api.js';

import {
  redisUrl,
  requiredArtifactEnvironment,
  artifactTransferDatabaseConfig,
} from './environment.js';

export function artifactApiConfig(): ApiConfig {
  return {
    capacity: DEFAULT_INSTANCE_LIMITS,
    webhookEndpointBurstLimit:
      DEFAULT_INSTANCE_LIMITS.webhookEndpointBurstLimit,
    codeSettings: DEFAULT_CODE_SETTINGS,
    artifacts: artifactStoreConfig(),
    database: artifactTransferDatabaseConfig,
    host: '127.0.0.1',
    identity: {
      publicWebOrigin: 'https://api.integration.test',
      session: {
        ttlMillis: 300_000,
        secureCookie: true,
        sameSite: 'lax',
      },
      betterAuth: {
        secret: 'artifact-transfer-integration-secret-with-32-plus-characters',
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
      serviceVersion: 'artifact-transfer-integration',
    },
    port: 3000,
    redisUrl,
  };
}

export function artifactStoreConfig(): ArtifactStoreConfig {
  const required = (name: keyof typeof requiredArtifactEnvironment): string => {
    const value = requiredArtifactEnvironment[name];
    if (value === undefined || value.trim() === '')
      throw new Error(`Missing artifact integration setting ${name}`);
    return value;
  };
  return {
    accessKeyId: required('ARTIFACT_STORE_ACCESS_KEY_ID'),
    bucket: required('ARTIFACT_STORE_BUCKET'),
    endpoint: required('ARTIFACT_STORE_ENDPOINT'),
    forcePathStyle: true,
    maxObjectBytes: Number(process.env.ARTIFACT_MAX_BYTES ?? 5 * 1024 ** 3),
    region: required('ARTIFACT_STORE_REGION'),
    requestTimeoutMs: Number(
      process.env.ARTIFACT_STORE_REQUEST_TIMEOUT_MS ?? 5_000,
    ),
    secretAccessKey: required('ARTIFACT_STORE_SECRET_ACCESS_KEY'),
  };
}
