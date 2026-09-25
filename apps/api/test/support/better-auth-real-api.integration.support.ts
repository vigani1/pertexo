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

import { createApiApplication } from '../../src/app.js';
import { LocalAuthenticationMailSink } from '../../src/identity-infrastructure/index.js';
import type { ApiConfig } from '../../src/platform/config/api-config.js';
import { createApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';

/*
 * The whole API with Better Auth as the only session authority and no legacy
 * OIDC, on its own disposable database (ADR 042/043).
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
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
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

/**
 * Creates and migrates a disposable database, boots the API on it and drops
 * the database afterwards. Each request gets its own client address, like
 * real users, so rate windows never couple the tests.
 */
export function useBetterAuthRealApi(suite: string) {
  const databaseName = `pertexo_test_ba_${suite}_${randomUUID().replaceAll('-', '')}`;
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
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker`,
    );
    await admin.end();
    await migrateDatabase({
      apiRuntimeRole: 'pertexo_api',
      connectionString: databaseUrl(migrationBaseUrl),
      dispatcherRole: 'pertexo_dispatcher',
      lifecycleCommandRole: 'pertexo_lifecycle_command',
      maintenanceRole: 'pertexo_maintenance',
      operatorRole: 'pertexo_operator',
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });
    admin = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    const config = apiConfig(databaseConfig);
    if (config.identity === undefined) throw new Error('Identity is missing');
    identityRuntime = await createApiIdentityRuntime(
      config.identity,
      databaseConfig,
      { authenticationMail: mail },
    );
    workspaceDatabase = createWorkspaceDatabase(databaseConfig);
    application = await createApiApplication(config, {
      database: workspaceDatabase,
      identityRuntime,
      logger: silent,
      telemetry,
    });
    await application.init();
  }, 60_000);

  afterAll(async () => {
    await application.close();
    await Promise.allSettled([
      identityRuntime?.close(),
      workspaceDatabase?.close(),
      admin.end(),
    ]);
    const cleanup = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await cleanup.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()`,
        [databaseName],
      );
      await cleanup.query(`drop database if exists "${databaseName}"`);
    } finally {
      await cleanup.end();
    }
  });

  function send(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    input: SendInput = {},
  ): Promise<Reply> {
    address += 1;
    return application.inject({
      method,
      url,
      remoteAddress: `203.0.113.${String(address % 250)}`,
      headers: {
        origin,
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

  return { send, signUp, signIn, mailedLink, database };
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
    nodeCompatibilityCohort: 'core',
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
