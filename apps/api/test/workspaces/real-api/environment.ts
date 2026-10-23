import { parseDatabaseConfig } from '@pertexo/database/testing';

import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';

const apiUrl = process.env.DATABASE_URL;

export const redisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';

export const enabled =
  process.env.API_IDENTITY_INTEGRATION === 'true' && apiUrl !== undefined;

export const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';

export const publicOrigin = 'https://api.integration.test';

export const password = 'a long enough integration password';

export const invitationKeys = {
  current: {
    version: 'integration-v1',
    key: Buffer.alloc(32, 0x5a).toString('base64'),
  },
  previous: [],
};

export const databaseConfig = parseDatabaseConfig({
  connectionString: apiUrl ?? 'postgresql://invalid:invalid@localhost/invalid',
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
  max: 4,
  ownerRole,
});

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
