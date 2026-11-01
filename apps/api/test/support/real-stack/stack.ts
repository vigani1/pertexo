import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { migrateDatabase } from '@pertexo/database/testing';
import { Redis } from 'ioredis';
import { Pool } from 'pg';

import { dropDisconnectedDatabase } from '../disposable-database.js';

const repository = new URL('../../../../../', import.meta.url);

/**
 * Each suite's own Redis database, since vitest runs files side by side and the stack flushes on
 * start and close. 1 to 9 are free of the worker's and browser suites, which use 10 to 15.
 */
const SUITE_REDIS_DATABASES = {
  capacity: 9,
  'timed-waits': 8,
  'webhook-endpoints': 7,
} as const;

/** Enough to read what went wrong, without growing without bound on a broken stack. */
const MAX_KEPT_ERROR_LINES = 200;

/** The operator's starting point: the shipped example, with this slot's services. */
function exampleEnvironment(): Record<string, string> {
  const lines = readFileSync(new URL('.env.example', repository), 'utf8').split(
    '\n',
  );
  const values: Record<string, string> = {};
  for (const line of lines) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined)
      values[match[1]] = match[2];
  }
  return values;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string')
          reject(new Error('No free port'));
        else resolve(address.port);
      });
    });
  });
}

function isRunning(child: ChildProcess) {
  return child.exitCode === null && child.signalCode === null;
}

function suiteRedisUrl(suite: keyof typeof SUITE_REDIS_DATABASES): string {
  return Object.assign(new URL(required('REDIS_URL')), {
    pathname: `/${String(SUITE_REDIS_DATABASES[suite])}`,
  }).toString();
}

async function clearRedis(url: string): Promise<void> {
  const redis = new Redis(url);
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

function withDatabase(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Real API and worker processes from their built entry points, on a disposable database. */
export function createRealStack(suite: keyof typeof SUITE_REDIS_DATABASES) {
  const databaseName = `pertexo_test_stack_${randomUUID().replaceAll('-', '')}`;
  const redisUrl = suiteRedisUrl(suite);
  const processes = new Set<ChildProcess>();
  const output = new Map<ChildProcess, string>();
  const errorLogs = new Map<ChildProcess, string[]>();
  let admin: Pool | undefined;
  let owner: Pool | undefined;
  let port: number | undefined;

  async function create() {
    await clearRedis(redisUrl);
    admin = new Pool({
      connectionString: required('DATABASE_ADMIN_URL'),
      max: 1,
    });
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_app, pertexo_maintenance`,
    );
    const migrationUrl = withDatabase(
      required('DATABASE_MIGRATION_URL'),
      databaseName,
    );
    await migrateDatabase({
      connectionString: migrationUrl,
      ownerRole: 'pertexo_owner',
      appRole: 'pertexo_app',
      maintenanceRole: 'pertexo_maintenance',
    });
    owner = new Pool({
      connectionString: withDatabase(
        required('DATABASE_ADMIN_URL'),
        databaseName,
      ),
      max: 1,
    });
  }

  function start(
    entry: string,
    environment: Record<string, string>,
  ): ChildProcess {
    const child = spawn(
      process.execPath,
      [new URL(entry, repository).pathname],
      {
        cwd: repository,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    processes.add(child);
    output.set(child, '');
    const errors: string[] = [];
    errorLogs.set(child, errors);
    const record = (chunk: Buffer) => {
      output.set(
        child,
        ((output.get(child) ?? '') + chunk.toString()).slice(-4000),
      );
    };
    // The tail above rolls past a burst's first failures, so errors are kept whole.
    let unfinishedLine = '';
    child.stdout.on('data', (chunk: Buffer) => {
      record(chunk);
      const lines = (unfinishedLine + chunk.toString()).split('\n');
      unfinishedLine = lines.pop() ?? '';
      if (errors.length < MAX_KEPT_ERROR_LINES)
        errors.push(...lines.filter((line) => /^\{"level":[56]0/u.test(line)));
    });
    child.stderr.on('data', record);
    child.once('exit', () => {
      processes.delete(child);
    });
    return child;
  }

  async function stop(child: ChildProcess) {
    if (!isRunning(child)) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, delay(15_000)]);
    if (isRunning(child)) child.kill('SIGKILL');
  }

  function environment(
    listenPort: number,
    settings: Readonly<Record<string, string>>,
  ) {
    return {
      PATH: process.env.PATH ?? '',
      ...exampleEnvironment(),
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(listenPort),
      PUBLIC_WEB_ORIGIN: `http://127.0.0.1:${String(listenPort)}`,
      DATABASE_URL: withDatabase(required('DATABASE_URL'), databaseName),
      DATABASE_MAINTENANCE_URL: withDatabase(
        required('DATABASE_MAINTENANCE_URL'),
        databaseName,
      ),
      DATABASE_MIGRATION_URL: withDatabase(
        required('DATABASE_MIGRATION_URL'),
        databaseName,
      ),
      REDIS_URL: redisUrl,
      ARTIFACT_STORE_ENDPOINT: required('ARTIFACT_STORE_ENDPOINT'),
      ARTIFACT_STORE_ACCESS_KEY_ID: required('ARTIFACT_STORE_ACCESS_KEY_ID'),
      ARTIFACT_STORE_SECRET_ACCESS_KEY: required(
        'ARTIFACT_STORE_SECRET_ACCESS_KEY',
      ),
      ARTIFACT_STORE_BUCKET: required('ARTIFACT_STORE_BUCKET'),
      CODE_STEPS_ENABLED: 'false',
      LOG_LEVEL: 'error',
      ...settings,
    };
  }

  /** Boots both processes with the operator's settings and waits until the API is ready. */
  async function boot(settings: Readonly<Record<string, string>> = {}) {
    // One address across restarts, so a signed-in session stays valid like a real install's.
    port ??= await freePort();
    const origin = `http://127.0.0.1:${String(port)}`;
    const env = environment(port, settings);
    const api = start('apps/api/dist/main.js', env);
    const worker = start('apps/worker/dist/main.js', env);
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (api.exitCode !== null)
        throw new Error(`API exited: ${output.get(api) ?? ''}`);
      if (worker.exitCode !== null)
        throw new Error(`Worker exited: ${output.get(worker) ?? ''}`);
      const ready = await fetch(`${origin}/health/ready`, {
        signal: AbortSignal.timeout(2_000),
      }).catch(() => undefined);
      if (ready?.status === 200) break;
      if (Date.now() > deadline)
        throw new Error(`API never became ready: ${output.get(api) ?? ''}`);
      await delay(200);
    }
    return {
      origin,
      stop: () => Promise.all([stop(api), stop(worker)]),
      /** The API's logged errors so far, as written, to say why a request failed. */
      apiErrors: () => [...(errorLogs.get(api) ?? [])],
    };
  }

  /** Waits for a process given these settings to refuse them. */
  async function bootExitCode(settings: Readonly<Record<string, string>>) {
    const env = environment(await freePort(), settings);
    const api = start('apps/api/dist/main.js', env);
    const deadline = Date.now() + 20_000;
    while (api.exitCode === null && Date.now() < deadline) await delay(100);
    const code = api.exitCode;
    await stop(api);
    return { code, output: output.get(api) ?? '' };
  }

  async function close() {
    await Promise.all([...processes].map(stop));
    await clearRedis(redisUrl);
    await owner?.end();
    if (admin !== undefined) {
      await dropDisconnectedDatabase(admin, databaseName);
      await admin.end();
    }
  }

  async function verifyEmail(email: string) {
    if (owner === undefined) throw new Error('Stack not created');
    await owner.query(
      'update app.users set email_verified=true where email=$1',
      [email],
    );
  }

  return { create, boot, bootExitCode, close, verifyEmail };
}

export type RealStack = ReturnType<typeof createRealStack>;
