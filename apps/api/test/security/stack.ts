import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { migrateDatabase } from '@pertexo/database/testing';
import { Redis } from 'ioredis';
import { Pool, type QueryResultRow } from 'pg';

import { dropDisconnectedDatabase } from '../support/disposable-database.js';
import type { Browser } from './actions.js';

const API_ENTRY = fileURLToPath(new URL('../../dist/main.js', import.meta.url));
const WORKER_ENTRY = fileURLToPath(
  new URL('../../../worker/dist/main.js', import.meta.url),
);

const adminUrl = requireEnvironment('DATABASE_ADMIN_URL');
const migrationUrl = requireEnvironment('DATABASE_MIGRATION_URL');
const appUrl = requireEnvironment('DATABASE_URL');
const maintenanceUrl = requireEnvironment('DATABASE_MAINTENANCE_URL');
const redisUrl = requireEnvironment('REDIS_URL');

function requireEnvironment(name: string): string {
  const value = process.env[name];
  // Enabled suites only import this file when the integration gate is on.
  if (value === undefined || value === '')
    throw new Error(`The real-process stack needs ${name}`);
  return value;
}

/** A compiled API or worker as production runs it: its own PID, its own heap. */
export class RealProcess {
  private output = '';
  private exited: Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }> | null = null;

  public constructor(
    public readonly name: string,
    private readonly child: ChildProcess,
  ) {
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const capture = (chunk: string) => {
      this.output += chunk;
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('exit', (code, signal) => {
      this.exited = { code, signal };
    });
  }

  public get alive(): boolean {
    return this.exited === null;
  }

  public get logs(): string {
    return this.output;
  }

  /** What a failed survival check needs to say. */
  public describeExit(): string {
    if (this.exited === null) return `${this.name} is running`;
    const fatal =
      /FATAL ERROR[^\n]*/u.exec(this.output)?.[0] ?? 'no fatal line';
    return `${this.name} exited (code ${String(this.exited.code)}, signal ${String(this.exited.signal)}): ${fatal}`;
  }

  public async stop(): Promise<void> {
    if (this.exited !== null) return;
    this.child.kill('SIGTERM');
    for (let waited = 0; waited < 15_000 && this.alive; waited += 100)
      await delay(100);
    if (this.alive) this.child.kill('SIGKILL');
  }
}

function databaseUrl(base: string, name: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

// Files run in parallel and rate-limit counters and queues can't be prefixed,
// so each stack leases a whole Redis database that nothing else in the suite
// uses. The compose project owns this Redis alone.
const REDIS_DATABASES = [5, 6, 7, 8, 9];
const LEASE_SECONDS = 900;

async function leaseRedisDatabase(owner: string): Promise<{
  url: string;
  release: () => Promise<void>;
}> {
  const coordinator = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  const deadline = Date.now() + 240_000;
  try {
    while (Date.now() < deadline) {
      for (const database of REDIS_DATABASES) {
        const lease = `pertexo:test:security-stack:${String(database)}`;
        const taken = await coordinator.set(
          lease,
          owner,
          'EX',
          LEASE_SECONDS,
          'NX',
        );
        if (taken !== 'OK') continue;
        const parsed = new URL(redisUrl);
        parsed.pathname = `/${String(database)}`;
        const url = parsed.toString();
        await flush(url);
        return {
          url,
          release: async () => {
            const releasing = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
            try {
              await releasing.del(lease);
            } finally {
              releasing.disconnect();
            }
          },
        };
      }
      await delay(500);
    }
  } finally {
    coordinator.disconnect();
  }
  throw new Error('No Redis database came free for the real-process stack');
}

async function flush(url: string): Promise<void> {
  const client = new Redis(url, { maxRetriesPerRequest: 1 });
  try {
    await client.flushdb();
  } finally {
    client.disconnect();
  }
}

/** The system's pick: a random one can land on a port an outgoing connection holds. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === 'string')
    throw new Error('The system gave no port');
  return address.port;
}

export type StackOptions = Readonly<{
  /** The public origin the API believes it is served on. */
  webOrigin?: string;
  port?: number;
  worker?: boolean;
  /** Replaces what the API and worker see; `undefined` removes a setting. */
  environment?: Readonly<Record<string, string | undefined>>;
  host?: string;
}>;

export type Reply = Readonly<{
  status: number;
  headers: Headers;
  text: string;
  json: () => unknown;
}>;

export type Stack = Awaited<ReturnType<typeof startStack>>;

/**
 * A fresh database and Redis with the real compiled API, and optionally the
 * real compiled worker, as separate processes: the only way to see a process
 * die. The default environment is what a development install runs with.
 */
export async function startStack(options: StackOptions = {}) {
  const name = `pertexo_test_security_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`create database "${name}" owner pertexo_owner`);
  await admin.query(
    `grant connect on database "${name}" to pertexo_migration, pertexo_app, pertexo_maintenance`,
  );
  await migrateDatabase({
    appRole: 'pertexo_app',
    connectionString: databaseUrl(migrationUrl, name),
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
  });
  const inspection = new Pool({
    connectionString: databaseUrl(adminUrl, name),
    max: 2,
  });
  const redis = await leaseRedisDatabase(name);
  const port = options.port ?? (await freePort());
  const apiOrigin = `http://127.0.0.1:${String(port)}`;
  const webOrigin = options.webOrigin ?? apiOrigin;
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: 'development',
    LOG_LEVEL: 'info',
    DATABASE_URL: databaseUrl(appUrl, name),
    DATABASE_MAINTENANCE_URL: databaseUrl(maintenanceUrl, name),
    REDIS_URL: redis.url,
    ARTIFACT_STORE_ENDPOINT: process.env.ARTIFACT_STORE_ENDPOINT,
    ARTIFACT_STORE_REGION: process.env.ARTIFACT_STORE_REGION,
    ARTIFACT_STORE_BUCKET: process.env.ARTIFACT_STORE_BUCKET,
    ARTIFACT_STORE_ACCESS_KEY_ID: process.env.ARTIFACT_STORE_ACCESS_KEY_ID,
    ARTIFACT_STORE_SECRET_ACCESS_KEY:
      process.env.ARTIFACT_STORE_SECRET_ACCESS_KEY,
    ARTIFACT_STORE_FORCE_PATH_STYLE: 'true',
    BETTER_AUTH_SECRET:
      'real-process-integration-secret-with-32-plus-characters',
    AUTH_MAIL_MODE: 'local',
    PUBLIC_WEB_ORIGIN: webOrigin,
    CALLBACK_TOKEN_KEY: 'RkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkY',
    CALLBACK_TOKEN_KEY_VERSION: 'v1',
    CONNECTION_ENCRYPTION_MODE: 'self-managed',
    CONNECTION_SELF_MANAGED_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    CONNECTION_SELF_MANAGED_KEY_VERSION: 'local:development',
    CODE_STEPS_ENABLED: 'false',
    TRUST_PROXY_CIDRS: '127.0.0.1/32',
    ...options.environment,
  };
  const start = (
    processName: string,
    entry: string,
    extra: NodeJS.ProcessEnv,
  ) =>
    new RealProcess(
      processName,
      spawn(process.execPath, [entry], {
        env: { ...base, ...extra },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  const api = start('API', API_ENTRY, {
    PORT: String(port),
    HOST: options.host ?? '127.0.0.1',
    // The worker would also want a mail provider for these; the API only seals.
    INVITATION_TOKEN_KEY: Buffer.alloc(32, 0x3c).toString('base64'),
    INVITATION_TOKEN_KEY_VERSION: 'invite-v1',
  });
  const stack = {
    apiOrigin,
    webOrigin,
    api,
    worker: undefined as RealProcess | undefined,
    flushRedis,
    query: <Row extends object>(sql: string, values: unknown[] = []) =>
      inspection.query<Row & QueryResultRow>(sql, values),
    send,
    close,
  };

  async function send(
    method: string,
    path: string,
    input: Readonly<{
      body?: unknown;
      headers?: Readonly<Record<string, string>>;
      address?: string;
      browser?: Browser;
      /** A server-to-server caller such as a webhook sender sends none. */
      withoutOrigin?: boolean;
    }> = {},
  ): Promise<Reply> {
    const response = await fetch(new URL(path, apiOrigin), {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: {
        ...(input.withoutOrigin === true ? {} : { origin: webOrigin }),
        ...(input.address === undefined
          ? {}
          : { 'x-forwarded-for': input.address }),
        ...(input.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
        ...(input.browser === undefined
          ? {}
          : {
              cookie: input.browser.cookie,
              'x-csrf-token': input.browser.csrf,
            }),
        ...input.headers,
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      json: () => JSON.parse(text) as unknown,
    };
  }

  /** Forgets every rate-limit counter, so one test's attack can't reach the next. */
  function flushRedis(): Promise<void> {
    return flush(redis.url);
  }

  async function close(): Promise<void> {
    await Promise.allSettled([api.stop(), stack.worker?.stop()]);
    await inspection.end();
    await redis.release();
    await dropDisconnectedDatabase(admin, name).finally(() => admin.end());
  }

  try {
    await waitUntil(`${apiOrigin}/health/ready`, api);
    if (options.worker === true) {
      // A loaded machine can miss the worker's readiness deadline at boot.
      for (let attempt = 1; stack.worker === undefined; attempt++) {
        const worker = start('worker', WORKER_ENTRY, {});
        if (await startedWithin(worker, 45_000)) stack.worker = worker;
        else if (attempt === 6) throw new Error(worker.logs.slice(-2_000));
        else {
          await worker.stop();
          await delay(5_000);
        }
      }
    }
  } catch (error: unknown) {
    await close();
    throw error;
  }
  return stack;
}

async function startedWithin(
  worker: RealProcess,
  millis: number,
): Promise<boolean> {
  for (let waited = 0; waited < millis; waited += 200) {
    if (worker.logs.includes('"worker.started"')) return true;
    if (!worker.alive) return false;
    await delay(200);
  }
  return false;
}

async function waitUntil(url: string, owner: RealProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!owner.alive)
      throw new Error(`${owner.describeExit()}\n${owner.logs.slice(-2_000)}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await delay(150);
  }
  throw new Error(
    `${owner.name} never became ready\n${owner.logs.slice(-2_000)}`,
  );
}
