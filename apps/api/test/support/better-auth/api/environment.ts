import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';

/*
 * The whole API with Better Auth as the only session authority and no legacy
 * OIDC, on its own disposable database (ADRs 039/043).
 */
export const betterAuthIntegrationEnabled =
  process.env.API_IDENTITY_INTEGRATION === 'true';

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

export const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

export const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

export const redisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';

export const origin = 'https://app.integration.test';

export const invitationKeys = {
  current: {
    version: 'invite-v1',
    key: Buffer.alloc(32, 0x3c).toString('base64'),
  },
  previous: [],
};

export const password = 'a long enough integration password';

export const silent: StructuredLogger = {
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
