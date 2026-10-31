import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { migrateDatabase } from '@pertexo/database/testing';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { expect } from 'vitest';

import { dropDisconnectedDatabase } from '../../support/disposable-database.js';

const repository = new URL('../../../../../', import.meta.url);
const password = 'a long enough integration password';

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

/** This stack's own Redis database, so its jobs never reach another suite's worker. */
function stackRedisUrl(): string {
  const redis = new URL(required('REDIS_URL'));
  redis.pathname = '/12';
  return redis.toString();
}

async function clearStackRedis(): Promise<void> {
  const redis = new Redis(stackRedisUrl(), { lazyConnect: true });
  try {
    await redis.connect();
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
export function createCapacityStack() {
  const databaseName = `pertexo_test_capacity_${randomUUID().replaceAll('-', '')}`;
  const processes = new Set<ChildProcess>();
  const output = new Map<ChildProcess, string>();
  let admin: Pool | undefined;
  let owner: Pool | undefined;
  let port: number | undefined;

  async function create() {
    await clearStackRedis();
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
    const record = (chunk: Buffer) => {
      output.set(
        child,
        ((output.get(child) ?? '') + chunk.toString()).slice(-4000),
      );
    };
    child.stdout.on('data', record);
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
      REDIS_URL: stackRedisUrl(),
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
    await clearStackRedis();
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

export type CapacityStack = ReturnType<typeof createCapacityStack>;

/** Signs one person up over real HTTP; sign-ups are rate limited, so a suite shares them. */
export async function signUp(stack: CapacityStack, origin: string) {
  const email = `capacity-${randomUUID()}@example.test`;
  const headers = { origin, 'content-type': 'application/json' };
  const created = await fetch(`${origin}/v1/auth/sign-up/email`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Capacity owner',
      email,
      password,
      callbackURL: '/workspaces',
    }),
  });
  expect(created.status, await created.text()).toBe(200);
  await stack.verifyEmail(email);
  const signedIn = await fetch(`${origin}/v1/auth/sign-in/email`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password, callbackURL: '/workspaces' }),
  });
  expect(signedIn.status, await signedIn.text()).toBe(200);
  const cookies = signedIn.headers.getSetCookie();
  const cookie = (name: string) => {
    const value = cookies
      .find((entry) => entry.startsWith(`${name}=`))
      ?.split(';', 1)[0]
      ?.slice(name.length + 1);
    if (value === undefined) throw new Error(`${name} cookie missing`);
    return value;
  };
  const session = cookie('pertexo_session');
  const csrf = cookie('pertexo_csrf');
  return function send(
    method: string,
    path: string,
    payload?: unknown,
    extra: Readonly<Record<string, string>> = {},
  ) {
    return fetch(`${origin}${path}`, {
      method,
      headers: {
        origin,
        cookie: `pertexo_session=${session}; pertexo_csrf=${csrf}`,
        'x-csrf-token': decodeURIComponent(csrf),
        ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
        ...(payload === undefined
          ? {}
          : { 'content-type': 'application/json' }),
        ...extra,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  };
}

/** A workspace of its own, so one test's runs don't count against another's. */
export async function ownWorkspace(send: Awaited<ReturnType<typeof signUp>>) {
  const workspace = await send('POST', '/v1/workspaces', {
    name: 'Capacity',
    slug: `capacity-${randomUUID().slice(0, 8)}`,
  });
  expect(workspace.status).toBe(201);
  const { id: workspaceId } = (await workspace.json()) as { id: string };
  return { send, workspaceId, base: `/v1/workspaces/${workspaceId}` };
}

export type CapacityOwner = Awaited<ReturnType<typeof ownWorkspace>>;

export const step = (
  id: string,
  key: string,
  x: number,
  config: Readonly<Record<string, unknown>> = {},
) => ({
  id,
  definition: { key, version: 1 },
  position: { x, y: 0 },
  configVersion: 1,
  config,
  inputMappings: {},
  connectionRefs: {},
});

export async function publishGraph(
  owner: CapacityOwner,
  name: string,
  graph: Readonly<{ nodes: unknown[]; edges: unknown[] }>,
) {
  const created = await owner.send('POST', `${owner.base}/workflows`, { name });
  expect(created.status).toBe(201);
  const { workflow } = (await created.json()) as { workflow: { id: string } };
  const path = `${owner.base}/workflows/${workflow.id}`;
  const draft = await owner.send('GET', `${path}/draft`);
  const saved = await owner.send(
    'PUT',
    `${path}/draft`,
    { graph: { settings: {}, ...graph } },
    { 'if-match': String(draft.headers.get('etag')) },
  );
  const savedBody = await saved.text();
  expect(saved.status, savedBody).toBe(200);
  // The API asks for a retry when validation is saturated on a busy machine.
  for (let tries = 1; ; tries += 1) {
    const published = await owner.send('POST', `${path}/publish`, undefined, {
      'if-match': String(saved.headers.get('etag')),
    });
    const publishedBody = await published.text();
    if (published.status === 503 && tries < 5) {
      await delay(1_000);
      continue;
    }
    expect(published.status, publishedBody).toBe(200);
    break;
  }
  return { path, workflowId: workflow.id };
}

export async function usageCapacity(owner: CapacityOwner) {
  const response = await owner.send('GET', `${owner.base}/usage-capacity`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    execution: {
      activeRuns: number;
      queuedRuns: number;
      policy: { activeRunLimit: number; queuedRunLimit: number };
    };
    artifacts: { artifactCountLimit: number };
  };
}

/** A signed delivery with its own key, as a real sender would send it. */
export function signedDelivery(
  origin: string,
  endpointKey: string,
  secret: string,
) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1=${createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`${timestamp}.{}`)
    .digest('hex')}`;
  return fetch(`${origin}/hooks/${endpointKey}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      'x-pertexo-timestamp': timestamp,
      'x-pertexo-signature': signature,
    },
    body: '{}',
  });
}
