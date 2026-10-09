import { randomUUID } from 'node:crypto';

import {
  createWorkspaceDatabase,
  migrateDatabase,
  parseDatabaseConfig,
  type DatabaseConfig,
  type WorkspaceDatabase,
} from '@pertexo/database/testing';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect } from 'vitest';

import type { createApiApplication } from '../../src/app.js';
import { LocalAuthenticationMailSink } from '../../src/identity-infrastructure/index.js';
import type { ApiConfig } from '../../src/platform/config/api-config.js';
import { createApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';
import { FixtureResourceOwner } from './fixture-resource-owner.js';
import { dropDisconnectedDatabase } from './disposable-database.js';
import { createBetterAuthFixtureApplication } from './better-auth-fixture-application.js';
import type { ApiConnectionRuntimeOverrides } from '../../src/platform/connections/connection-runtime.module.js';
import type { ApiWebhookRuntime } from '../../src/platform/webhooks/webhook-runtime.module.js';
import { createApiNotificationRuntime } from '../../src/platform/notifications/notification-runtime.module.js';

/*
 * The whole API with Better Auth as the only session authority and no legacy
 * OIDC, on its own disposable database (ADRs 039/043).
 */
export const betterAuthIntegrationEnabled =
  process.env.API_IDENTITY_INTEGRATION === 'true';
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const redisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';
export const origin = 'https://app.integration.test';
export const invitationKeys = {
  current: {
    version: 'invite-v1',
    key: Buffer.alloc(32, 0x3c).toString('base64'),
  },
  previous: [],
};
const password = 'a long enough integration password';
const silent: StructuredLogger = {
  debug: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  info: () => undefined,
  trace: () => undefined,
  warn: () => undefined,
};
const telemetry: TelemetryLifecycle = {
  enabled: false,
  started: false,
  start: () => undefined,
  shutdown: () => Promise.resolve(),
};

export type Browser = Readonly<{
  session: string;
  csrf: string;
  cookie: string;
}>;
type Application = Awaited<ReturnType<typeof createApiApplication>>;
export type Reply = Awaited<ReturnType<Application['inject']>>;
type SendInput = Readonly<{
  browser?: Browser;
  headers?: Record<string, string>;
  payload?: object;
}>;

type DatabaseCleanupFailure =
  | 'database_connection_probe_deadline'
  | 'database_poll_wait_deadline'
  | 'database_drop_deadline'
  | 'database_query_deadline'
  | 'database_query_read_timeout'
  | 'database_cleanup_failure';

function databaseCleanupFailure(error: unknown): DatabaseCleanupFailure {
  const message: unknown =
    error instanceof Error
      ? Object.getOwnPropertyDescriptor(error, 'message')?.value
      : undefined;
  if (typeof message === 'string') {
    const stage =
      /^Disposable database (connection_probe|poll_wait|drop) (?:query exceeded [1-9][0-9]{0,8}ms|deadline expired before dispatch)$/u.exec(
        message,
      )?.[1];
    if (stage === 'connection_probe')
      return 'database_connection_probe_deadline';
    if (stage === 'poll_wait') return 'database_poll_wait_deadline';
    if (stage === 'drop') return 'database_drop_deadline';
  }
  if (
    typeof message === 'string' &&
    /^Disposable database query exceeded [1-9][0-9]{0,8}ms$/u.test(message)
  )
    return 'database_query_deadline';
  return message === 'Query read timeout'
    ? 'database_query_read_timeout'
    : 'database_cleanup_failure';
}

/**
 * Creates and migrates a disposable database, boots the API on it and drops
 * the database afterwards. Requests use distinct client addresses; the
 * application fixture scopes real Redis rate-limit counters per instance.
 */
export function useBetterAuthRealApi(
  suite: string,
  options: Readonly<{
    publicWebOrigin?: string;
    workflowOrganization?: ApiConfig['workflowOrganization'];
    /** F07-owned qualification namespace, never a shared database selection. */
    databaseNamespace?: 'f07_organization';
    redisUrl?: string;
    schedules?: boolean;
    /** Compose the real workspace inbox runtime (ADR 055). */
    notifications?: boolean;
    webhookRuntime?: (config: ApiConfig) => Promise<ApiWebhookRuntime>;
    logger?: StructuredLogger;
    connections?: Readonly<{
      config: NonNullable<ApiConfig['connections']>;
      overrides: ApiConnectionRuntimeOverrides;
    }>;
    afterMigration?: (databaseUrl: (base: string) => string) => Promise<void>;
    beforeClose?: () => Promise<void>;
    beforeDrop?: () => Promise<void>;
  }> = {},
) {
  const fixtureOrigin = options.publicWebOrigin ?? origin;
  const owner = new FixtureResourceOwner();
  let disposableDatabase: object | undefined;
  let databaseCleanupLabel: DatabaseCleanupFailure | undefined;
  const databaseName = `${options.databaseNamespace === undefined ? `pertexo_test_ba_${suite}` : 'pertexo_test_f07_organization'}_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = (base: string) => {
    const parsed = new URL(base);
    parsed.pathname = `/${databaseName}`;
    return parsed.toString();
  };
  const databaseConfig = parseDatabaseConfig({
    connectionString: databaseUrl(apiBaseUrl),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    max: 4,
    ownerRole: 'pertexo_owner',
  });
  const mail = new LocalAuthenticationMailSink();
  let application: Application;
  let workspaceDatabase: WorkspaceDatabase | undefined;
  let identityRuntime:
    Awaited<ReturnType<typeof createApiIdentityRuntime>> | undefined;
  let admin: Pool;
  let address = 0;

  beforeAll(async () => {
    const creator = owner.acquire(
      'database creator',
      new Pool({ connectionString: adminUrl, max: 1 }),
      (pool) => pool.end(),
    );
    await creator.query(
      `create database "${databaseName}" owner pertexo_owner`,
    );
    disposableDatabase = owner.acquire('disposable database', {}, async () => {
      try {
        const cleanup = new Pool({ connectionString: adminUrl, max: 1 });
        try {
          await dropDisconnectedDatabase(cleanup, databaseName, {
            ...(options.beforeDrop === undefined
              ? {}
              : { beforeDrop: options.beforeDrop }),
          });
        } finally {
          await cleanup.end();
        }
      } catch (error: unknown) {
        databaseCleanupLabel = databaseCleanupFailure(error);
        throw error;
      }
    });
    await creator.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_app, pertexo_app`,
    );
    await migrateDatabase({
      appRole: 'pertexo_app',
      connectionString: databaseUrl(migrationBaseUrl),
      maintenanceRole: 'pertexo_maintenance',
      ownerRole: 'pertexo_owner',
    });
    admin = owner.acquire(
      'inspection pool',
      new Pool({ connectionString: databaseUrl(adminUrl), max: 1 }),
      (pool) => pool.end(),
    );
    await options.afterMigration?.(databaseUrl);
    const defaults = apiConfig(databaseConfig);
    if (defaults.identity === undefined) throw new Error('Identity is missing');
    const identity = { ...defaults.identity, publicWebOrigin: fixtureOrigin };
    const config: ApiConfig = {
      ...defaults,
      identity,
      redisUrl: options.redisUrl ?? redisUrl,
      ...(options.workflowOrganization === undefined
        ? {}
        : { workflowOrganization: options.workflowOrganization }),
      ...(options.connections === undefined
        ? {}
        : { connections: options.connections.config }),
    };
    identityRuntime = owner.acquire(
      'identity runtime',
      await createApiIdentityRuntime(identity, databaseConfig, {
        authenticationMail: mail,
      }),
      (runtime) => runtime.close(),
    );
    workspaceDatabase = owner.acquire(
      'workspace database',
      createWorkspaceDatabase(databaseConfig),
      (database) => database.close(),
    );
    const webhookRuntime =
      options.webhookRuntime === undefined
        ? undefined
        : owner.acquire(
            'webhook runtime',
            await options.webhookRuntime(config),
            (runtime) => runtime.close(),
          );
    const notificationRuntime =
      options.notifications === true
        ? owner.acquire(
            'notification runtime',
            createApiNotificationRuntime(databaseConfig, config.redisUrl),
            (runtime) => runtime.close(),
          )
        : undefined;
    application = await createBetterAuthFixtureApplication(
      config,
      {
        database: workspaceDatabase,
        identityRuntime,
        logger: options.logger ?? silent,
        telemetry,
        ...(webhookRuntime === undefined ? {} : { webhookRuntime }),
        ...(notificationRuntime === undefined ? {} : { notificationRuntime }),
        ...(options.connections === undefined
          ? {}
          : { connectionOverrides: options.connections.overrides }),
      },
      owner,
      options.schedules,
    );
    if (webhookRuntime !== undefined) owner.transfer(webhookRuntime);
    if (notificationRuntime !== undefined) owner.transfer(notificationRuntime);
    await application.init();
  }, 60_000);

  afterAll(async () => {
    const report = { otherCleanupFailed: false };
    await Promise.resolve()
      .then(() => options.beforeClose?.())
      .catch(() => {
        // A caller could not confirm that its external clients stopped. Close
        // our listeners/pools, but do not drop the database under those clients.
        if (disposableDatabase !== undefined)
          owner.transfer(disposableDatabase);
        report.otherCleanupFailed = true;
      });
    await owner.close().catch((error: unknown) => {
      // This is the unchanged owner's aggregate, not arbitrary resource data.
      if (
        databaseCleanupLabel === undefined ||
        !(error instanceof AggregateError) ||
        error.errors.length > 1
      )
        report.otherCleanupFailed = true;
    });
    const labels = [
      ...(databaseCleanupLabel === undefined ? [] : [databaseCleanupLabel]),
      ...(report.otherCleanupFailed ? ['other_cleanup_failure'] : []),
    ];
    // Vitest serializes nested errors, including their causes and properties.
    // Keep originals inside the owner; only a fresh safe report crosses this boundary.
    if (labels.length > 0)
      throw new Error(
        `Better Auth fixture cleanup failed: ${labels.join(', ')}`,
      );
  });

  function send(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    input: SendInput = {},
  ): Promise<Reply> {
    address += 1;
    return application.inject({
      method,
      url,
      remoteAddress: `203.0.113.${String(address % 250)}`,
      headers: {
        origin: fixtureOrigin,
        ...(input.browser === undefined
          ? {}
          : {
              cookie: input.browser.cookie,
              'x-csrf-token': input.browser.csrf,
            }),
        ...input.headers,
      },
      ...(input.payload === undefined ? {} : { payload: input.payload }),
    });
  }

  /** The newest link of one purpose mailed to an address. */
  function mailedLink(email: string, purpose: string): URL {
    const message = mail
      .readForTesting(email)
      .filter((item) => item.purpose === purpose)
      .at(-1);
    if (message === undefined) throw new Error(`No ${purpose} mail`);
    return new URL(message.url);
  }

  /** Signs up and follows the verification link to its landing page. */
  async function signUp(email: string, callbackURL: string) {
    const created = await send('POST', '/v1/auth/sign-up/email', {
      payload: { name: 'New Person', email, password, callbackURL },
    });
    expect(created.statusCode, created.payload).toBe(200);
    const link = mailedLink(email, 'verification');
    const verified = await send('GET', link.pathname + link.search);
    expect(verified.statusCode).toBe(302);
    return { link, landing: new URL(String(verified.headers.location)) };
  }

  async function signIn(email: string): Promise<Browser> {
    const signedIn = await send('POST', '/v1/auth/sign-in/email', {
      payload: { email, password, callbackURL: '/workspaces' },
    });
    expect(signedIn.statusCode, signedIn.payload).toBe(200);
    return browserFrom(signedIn);
  }

  /** The superuser pool on the disposable database, for inspection. */
  function database(): Pool {
    return admin;
  }

  async function listen(): Promise<string> {
    await application.listen(0, '127.0.0.1');
    return application.getUrl();
  }

  return { send, signUp, signIn, mailedLink, database, listen };
}

function apiConfig(database: DatabaseConfig): ApiConfig {
  return {
    database,
    host: '127.0.0.1',
    identity: {
      publicWebOrigin: origin,
      invitationTokenEncryption: invitationKeys,
      session: { ttlMillis: 3_600_000, secureCookie: false, sameSite: 'lax' },
      betterAuth: {
        secret: 'better-auth-only-integration-secret-with-32-plus-characters',
        mailMode: 'local',
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

function setCookies(reply: Reply): string[] {
  const header = reply.headers['set-cookie'];
  return Array.isArray(header) ? header : [header ?? ''];
}

export function setCookie(reply: Reply, name: string): string {
  const cookie = setCookies(reply).find((value) =>
    value.startsWith(`${name}=`),
  );
  const value = cookie?.split(';', 1)[0]?.slice(name.length + 1);
  if (value === undefined || value === '')
    throw new Error(`${name} cookie was not returned`);
  return value;
}

export function browserFrom(reply: Reply): Browser {
  const session = setCookie(reply, 'pertexo_session');
  const csrf = decodeURIComponent(setCookie(reply, 'pertexo_csrf'));
  return {
    session,
    csrf,
    cookie: `pertexo_session=${session}; pertexo_csrf=${encodeURIComponent(csrf)}`,
  };
}

export function expectProblem(
  reply: Reply,
  status: number,
  code: string,
): void {
  expect(reply.statusCode, reply.payload).toBe(status);
  expect(reply.json()).toMatchObject({ status, code });
}
