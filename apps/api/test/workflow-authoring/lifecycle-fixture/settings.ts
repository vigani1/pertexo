import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';

import type { WorkspaceDatabase } from '@pertexo/database/testing';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import type { ApiConfig } from '../../../src/platform/config/api.js';

import { redisUrl, workflowLifecycleDatabaseConfig } from './environment.js';

export const logger: StructuredLogger = {
  debug: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  info: () => undefined,
  trace: () => undefined,
  warn: () => undefined,
};

export const telemetry: TelemetryLifecycle = {
  enabled: false,
  started: false,
  start: () => undefined,
  shutdown: () => Promise.resolve(),
};

export function apiConfig(): ApiConfig {
  return {
    codeSettings: DEFAULT_CODE_SETTINGS,
    database: workflowLifecycleDatabaseConfig,
    host: '127.0.0.1',
    identity: {
      publicWebOrigin: 'https://api.integration.test',
      session: {
        ttlMillis: 300_000,
        secureCookie: true,
        sameSite: 'lax',
      },
      betterAuth: {
        secret: 'workflow-lifecycle-integration-secret-with-32-plus-characters',
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
      serviceVersion: 'workflow-lifecycle-integration',
    },
    port: 3000,
    redisUrl: requireIntegrationUrl(redisUrl, 'REDIS_URL'),
  };
}

export function requireIntegrationUrl(
  value: string | undefined,
  name: string,
): string {
  if (value === undefined || value.trim() === '')
    throw new Error(`Workflow lifecycle integration requires ${name}`);
  return value;
}

export function borrowedWorkspaceDatabase(
  database: WorkspaceDatabase,
): WorkspaceDatabase {
  return Object.freeze({
    withWorkspace: database.withWorkspace.bind(database),
    checkReadiness: database.checkReadiness.bind(database),
    close: () => Promise.resolve(),
  });
}
