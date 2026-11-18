import { randomUUID } from 'node:crypto';

import type { StructuredLogger } from '@pertexo/observability/server';
import type { TelemetryLifecycle } from '@pertexo/observability/startup';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createApiApplication } from '../../src/app.js';
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
  },
);
