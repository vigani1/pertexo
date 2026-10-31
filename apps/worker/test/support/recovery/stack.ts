import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  migrateDatabase,
  parseMigrationConfig,
} from '@pertexo/database/testing';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { dropDisconnectedDatabase } from '../infrastructure/disposable-database.js';
import { createRedisTestNamespace } from '../infrastructure/redis-test-namespace.js';

import { ApiClient } from './api.js';
import { composeUrls, roles, serviceEnvironment } from './environment.js';
import { ServiceProcess } from './processes.js';
import { redisCommand } from './services.js';
import { startSink, type Sink } from './sink.js';

const entrypoint = (app: 'api' | 'ops' | 'worker'): string =>
  fileURLToPath(new URL(`../../../../${app}/dist/main.js`, import.meta.url));

const REDIS_DATABASE = 14;
const DEFAULT_WEB_ORIGIN = 'http://127.0.0.1:5999';
const START_LIMIT_MS = 120_000;

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function onDatabase(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function createMigratedDatabase(databaseName: string): Promise<void> {
  const admin = new Pool({ connectionString: composeUrls.admin, max: 1 });
  try {
    await admin.query(
      `create database ${quote(databaseName)} owner ${quote(roles.owner)}`,
    );
    await admin.query(
      `revoke all on database ${quote(databaseName)} from public`,
    );
    await admin.query(
      `grant connect on database ${quote(databaseName)} to ${[
        roles.migration,
        roles.app,
        roles.maintenance,
      ]
        .map(quote)
        .join(',')}`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase(
    parseMigrationConfig({
      ...process.env,
      DATABASE_MIGRATION_URL: onDatabase(composeUrls.migration, databaseName),
      NODE_ENV: 'test',
    }),
  );
}

export type Stack = Readonly<{
  api: ApiClient;
  apiProcess: ServiceProcess;
  /** Where the real API listens. */
  baseUrl: string;
  close: () => Promise<void>;
  /** One connection of the test's own, for locks held across statements. */
  connect: () => Promise<PoolClient>;
  createWorker: (instance: string) => ServiceProcess;
  flushRedis: () => Promise<void>;
  operator: (environment: Readonly<Record<string, string>>) => ServiceProcess;
  redisDatabase: number;
  redisUrl: string;
  sink: Sink;
  sql: <Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<readonly Row[]>;
  worker: ServiceProcess;
}>;

export type StackOptions = Readonly<{
  /** Extra settings for the API and the worker. */
  environment?: Readonly<Record<string, string>>;
  /** Extra settings only the worker may have, such as mail delivery. */
  workerEnvironment?: Readonly<Record<string, string>>;
  /** Serves Slack from the sink, for steps and alerts that use a real connection. */
  slackFromSink?: boolean;
  /** The install's public web address, when a test needs a host other than the API's. */
  webOrigin?: string;
}>;

const providerPreload = fileURLToPath(
  new URL('./stand-ins/provider-preload.mjs', import.meta.url),
);

/**
 * A disposable install of the real compiled API and worker on default settings,
 * with one verified user. Queries read as the superuser, past row security, so
 * tests see what is stored in every workspace.
 */
export async function startStack(
  name: string,
  options: StackOptions = {},
): Promise<Stack> {
  const databaseName = `pertexo_test_recovery_${name.replaceAll('-', '_')}_${randomUUID().slice(0, 8)}`;
  const redisNamespace = createRedisTestNamespace(
    composeUrls.redis,
    REDIS_DATABASE,
    'worker-recovery',
  );
  await redisNamespace.acquire();
  await createMigratedDatabase(databaseName);

  const pool = new Pool({
    connectionString: onDatabase(composeUrls.admin, databaseName),
    max: 2,
  });
  // A stopped Postgres ends idle connections; a query after it reconnects.
  pool.on('error', () => undefined);

  const sink = await startSink();
  const port = await freePort();
  const webOrigin = options.webOrigin ?? DEFAULT_WEB_ORIGIN;
  const shared = {
    ...serviceEnvironment,
    DATABASE_MAINTENANCE_URL: onDatabase(composeUrls.maintenance, databaseName),
    DATABASE_URL: onDatabase(composeUrls.app, databaseName),
    PUBLIC_WEB_ORIGIN: webOrigin,
    REDIS_URL: redisNamespace.redisUrl,
    ...(options.slackFromSink === true
      ? {
          NODE_OPTIONS: `--import=${providerPreload}`,
          PROVIDER_STAND_IN_ORIGIN: sink.origin,
        }
      : {}),
    ...options.environment,
  };
  const apiProcess = new ServiceProcess(entrypoint('api'), {
    ...shared,
    PORT: String(port),
  });
  const createWorker = (instance: string): ServiceProcess =>
    new ServiceProcess(entrypoint('worker'), {
      ...shared,
      ...options.workerEnvironment,
      WORKER_INSTANCE_ID: instance,
    });
  const worker = createWorker('recovery-worker');
  const extraWorkers: ServiceProcess[] = [];

  const close = async (): Promise<void> => {
    await Promise.allSettled(
      [worker, apiProcess, ...extraWorkers].map((service) =>
        service.stop('SIGKILL'),
      ),
    );
    await sink.close();
    await pool.end();
    const admin = new Pool({ connectionString: composeUrls.admin, max: 1 });
    try {
      await dropDisconnectedDatabase(admin, databaseName);
    } finally {
      await admin.end();
    }
    await redisCommand(REDIS_DATABASE, 'FLUSHDB');
    await redisNamespace.close();
  };

  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const api = new ApiClient(baseUrl, webOrigin);
  try {
    apiProcess.start();
    const deadline = Date.now() + START_LIMIT_MS;
    for (;;) {
      const ready = await fetch(`${baseUrl}/health/ready`).catch(
        () => undefined,
      );
      if (ready?.ok === true) break;
      if (Date.now() > deadline)
        throw new Error(
          `API never became ready: ${apiProcess.logs
            .slice(-20)
            .map(({ text }) => text)
            .join('\n')}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const email = `recovery-${randomUUID().slice(0, 8)}@example.test`;
    await api.signUp(email);
    await pool.query(
      `update app.users set email_verified=true where email=$1`,
      [email],
    );
    await api.signIn(email);

    worker.start();
    await worker.waitForLog(/worker\.started/u, START_LIMIT_MS);
  } catch (error: unknown) {
    await close();
    throw error;
  }

  return Object.freeze({
    api,
    apiProcess,
    baseUrl,
    connect: () => pool.connect(),
    createWorker(instance) {
      const created = createWorker(instance);
      extraWorkers.push(created);
      return created;
    },
    async flushRedis() {
      const reply = await redisCommand(REDIS_DATABASE, 'FLUSHDB');
      if (reply !== 'OK') throw new Error(`FLUSHDB answered ${reply}`);
    },
    operator(environment) {
      return new ServiceProcess(entrypoint('ops'), {
        ...serviceEnvironment,
        DATABASE_MAINTENANCE_URL: shared.DATABASE_MAINTENANCE_URL,
        OPERATOR_ACTOR_REF: 'recovery:test',
        OPERATOR_COMMAND_ID: randomUUID(),
        OPERATOR_REASON: 'recovery test',
        ...environment,
      });
    },
    redisDatabase: REDIS_DATABASE,
    redisUrl: redisNamespace.redisUrl,
    sink,
    async sql<Row extends QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ) {
      const result = await pool.query<Row>(text, [...values]);
      return result.rows;
    },
    worker,
    close,
  });
}
