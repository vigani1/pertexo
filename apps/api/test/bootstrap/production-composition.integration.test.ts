import { randomUUID } from 'node:crypto';

import type { StructuredLogger } from '@pertexo/observability';
import type { TelemetryLifecycle } from '@pertexo/observability/startup';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createApiApplication } from '../../src/app.js';
import { parseApiConfig } from '../../src/platform/config/api.js';
import {
  apiBaseUrl,
  betterAuthIntegrationEnabled,
  redisUrl,
} from '../support/better-auth/api/environment.js';

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
    it('serves, reports ready and releases its database sessions on close', async () => {
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
        expect(await sessionsNamed(applicationName)).toBeGreaterThan(0);

        await application.close();
        closed = true;
        await expect
          .poll(() => sessionsNamed(applicationName), { timeout: 10_000 })
          .toBe(0);
      } finally {
        if (!closed) await application.close();
      }
    });
  },
);
