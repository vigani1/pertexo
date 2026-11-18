import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { fileURLToPath } from 'node:url';

import type { StructuredLogger } from '@pertexo/observability/server';
import type { TelemetryLifecycle } from '@pertexo/observability/startup';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createApiApplication } from '../../src/app.js';
import {
  acquireApiRuntimes,
  cleanupApiRuntimes,
} from '../../src/platform/api.runtime.js';
import { ApiDrainState } from '../../src/platform/health/drain-state.js';
import { parseApiConfig } from '../../src/platform/config/api-config.js';
import { betterAuthIntegrationEnabled } from '../support/better-auth/api/environment.js';
import { apiBaseUrl, redisUrl } from '../support/better-auth/api/stack.js';

const silent: StructuredLogger = {
  debug: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  info: () => undefined,
  trace: () => undefined,
  warn: () => undefined,
};

/** Database sessions this API process opened, found by its own name. */
async function sessionsNamed(applicationName: string): Promise<number> {
  const admin = new pg.Client({
    connectionString: process.env.DATABASE_ADMIN_URL,
  });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ count: number }>(
      'select count(*)::int as count from pg_stat_activity where application_name = $1',
      [applicationName],
    );
    return rows[0]?.count ?? 0;
  } finally {
    await admin.end();
  }
}

/**
 * How long the entry point may take to start, or to refuse and exit; twice
 * this stays inside the integration lane's timeout.
 */
const ENTRY_POINT_BUDGET_MS = 12_000;

function listening(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('The port holder has no TCP address');
  return address.port;
}

/**
 * Runs the built main.js as its own process, as the image does. Not
 * src/main.ts through tsx: tsx emits no decorator metadata, so Nest cannot
 * resolve the application's providers.
 */
function startEntryPoint(port: number, applicationName: string) {
  const url = new URL(apiBaseUrl);
  url.searchParams.set('application_name', applicationName);
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../dist/main.js', import.meta.url))],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        LOG_LEVEL: 'info',
        DATABASE_URL: url.toString(),
        REDIS_URL: redisUrl,
        BETTER_AUTH_SECRET: 'entry-point-secret-of-at-least-32-characters',
        AUTH_MAIL_MODE: 'local',
        PUBLIC_WEB_ORIGIN: 'https://app.integration.test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const seen: { marker: string; resolve: () => void }[] = [];
  const append = (chunk: string) => {
    output += chunk;
    for (const waiter of seen.filter(({ marker }) => output.includes(marker)))
      waiter.resolve();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
  const within = <T>(promise: Promise<T>, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`The entry point did not ${what}: ${output}`));
      }, ENTRY_POINT_BUDGET_MS);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  return {
    child,
    output: () => output,
    exit: () => within(exited, 'exit'),
    logged: (marker: string) =>
      within(
        output.includes(marker)
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              seen.push({ marker, resolve });
            }),
        `log ${marker}`,
      ),
  };
}

// The composition main() runs: configuration plus a logger and telemetry,
// with every feature runtime created from configuration. A refactor of the
// runtime seams must keep this path serving, ready and fully closable.
describe.runIf(betterAuthIntegrationEnabled)(
  'API production composition',
  () => {
    it('serves, reports ready, drains and releases its database sessions on close', async () => {
      const signalListeners = process.listenerCount('SIGTERM');
      const applicationName = `api-composition-${randomUUID()}`;
      const url = new URL(apiBaseUrl);
      url.searchParams.set('application_name', applicationName);
      const config = parseApiConfig({
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: '4399',
        DATABASE_URL: url.toString(),
        REDIS_URL: redisUrl,
        BETTER_AUTH_SECRET: 'production-composition-secret-of-32-characters',
        AUTH_MAIL_MODE: 'local',
        PUBLIC_WEB_ORIGIN: 'https://app.integration.test',
        // Every other real stack runs with none.
        TRUST_PROXY_CIDRS: '127.0.0.1/32',
      });
      const telemetry = {
        enabled: false,
        started: false,
        start: vi.fn(),
        shutdown: vi.fn(() => Promise.resolve()),
      } satisfies TelemetryLifecycle;
      const application = await createApiApplication(config, {
        logger: silent,
        telemetry,
      });
      let closed = false;
      try {
        const ready = await application.inject({
          method: 'GET',
          url: '/health/ready',
        });
        expect(ready.statusCode, ready.payload).toBe(200);
        expect(ready.json()).toEqual({ status: 'ready' });
        const anonymous = await application.inject({
          method: 'GET',
          url: '/v1/workspaces',
        });
        expect(anonymous.statusCode).toBe(401);
        const workspace = '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        for (const url of [
          '/v1/users/me',
          '/v1/node-definitions',
          '/v1/integrations',
          `${workspace}/members`,
          `${workspace}/workflows`,
          `${workspace}/runs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
          `${workspace}/notifications/summary`,
          `${workspace}/previews/dddddddd-dddd-4ddd-8ddd-dddddddddddd`,
          `${workspace}/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/triggers`,
          `${workspace}/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/triggers/schedules`,
        ])
          expect(
            (await application.inject({ method: 'GET', url })).statusCode,
            url,
          ).toBe(401);

        const live = await application.inject({
          method: 'GET',
          url: '/health/live',
        });
        expect(live.statusCode).toBe(200);
        expect(live.headers['content-type']).toContain('application/json');
        expect(live.payload).toBe('{"status":"ok"}');
        for (const url of [
          '/v1/workspaces/workspace-a/nonexistent',
          '/v1/workspaces/workspace-a/workflows/nonexistent/nested',
        ]) {
          const unknown = await application.inject({ method: 'GET', url });
          expect(unknown.statusCode, url).toBe(404);
          expect(unknown.headers['content-type']).toContain(
            'application/problem+json',
          );
          expect(unknown.json()).toMatchObject({
            status: 404,
            code: 'resource.not_found',
          });
        }
        expect(await sessionsNamed(applicationName)).toBeGreaterThan(0);

        application.get(ApiDrainState).beginDrain();
        const draining = await application.inject({
          method: 'GET',
          url: '/health/ready',
        });
        expect(draining.statusCode).toBe(503);
        expect(draining.json()).toEqual({ status: 'not_ready' });
        expect(draining.headers['x-request-id']).toBeTypeOf('string');

        await application.close();
        closed = true;
        await expect
          .poll(() => sessionsNamed(applicationName), { timeout: 10_000 })
          .toBe(0);
        expect(telemetry.shutdown).toHaveBeenCalledOnce();
        expect(process.listenerCount('SIGTERM')).toBe(signalListeners);
      } finally {
        if (!closed) await application.close();
      }
    });

    it('runs from its entry point: serves on the configured port and stops on SIGTERM', async () => {
      const applicationName = `api-entry-${randomUUID()}`;
      const probe = await listening();
      const port = portOf(probe);
      await new Promise((resolve) => probe.close(resolve));
      const entry = startEntryPoint(port, applicationName);
      try {
        await entry.logged('"event":"api.started"');
        const ready = await fetch(
          `http://127.0.0.1:${String(port)}/health/ready`,
        );
        expect(ready.status).toBe(200);
        expect(await ready.json()).toEqual({ status: 'ready' });
        expect(await sessionsNamed(applicationName)).toBeGreaterThan(0);
      } finally {
        entry.child.kill('SIGTERM');
      }
      expect(await entry.exit()).toEqual({ code: null, signal: 'SIGTERM' });
      expect(entry.output()).toContain(`"port":${String(port)}`);
      await expect
        .poll(() => sessionsNamed(applicationName), { timeout: 10_000 })
        .toBe(0);
    });

    it('exits with the listen failure after closing what it opened when its port is taken', async () => {
      const applicationName = `api-entry-taken-${randomUUID()}`;
      const holder = await listening();
      try {
        const entry = startEntryPoint(portOf(holder), applicationName);
        // Exiting at all shows the database pools and Redis clients closed:
        // either one left open keeps the process alive.
        expect(await entry.exit()).toEqual({ code: 1, signal: null });
        expect(entry.output()).toContain('"event":"api.bootstrap_failed"');
        expect(entry.output()).toContain('"event":"api.process_failed"');
        expect(entry.output()).not.toContain('"event":"api.started"');
        await expect
          .poll(() => sessionsNamed(applicationName), { timeout: 10_000 })
          .toBe(0);
      } finally {
        await new Promise((resolve) => holder.close(resolve));
      }
    });

    it('builds no identity features without identity settings', async () => {
      const applicationName = `api-no-identity-${randomUUID()}`;
      const url = new URL(apiBaseUrl);
      url.searchParams.set('application_name', applicationName);
      const runtimes = await acquireApiRuntimes(
        parseApiConfig({
          NODE_ENV: 'test',
          DATABASE_URL: url.toString(),
          REDIS_URL: redisUrl,
        }),
        { logger: silent },
      );
      try {
        expect(runtimes.identityRuntime).toBeUndefined();
        expect(runtimes.workflowRuntime).toBeUndefined();
        expect(runtimes.connectionRuntime).toBeUndefined();
        expect(runtimes.callbackRuntime).toBeDefined();
      } finally {
        expect(await cleanupApiRuntimes(runtimes)).toEqual([]);
      }
      await expect
        .poll(() => sessionsNamed(applicationName), { timeout: 10_000 })
        .toBe(0);
    });
  },
);
