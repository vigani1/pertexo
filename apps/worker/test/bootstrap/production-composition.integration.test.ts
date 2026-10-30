import { randomUUID } from 'node:crypto';

import type { StructuredLogger } from '@pertexo/observability';
import type { TelemetryLifecycle } from '@pertexo/observability/startup';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createWorkerApplication } from '../../src/app.js';
import { parseWorkerConfig } from '../../src/config/worker.js';
import { WorkerReadiness } from '../../src/runtime/health/readiness.js';

const enabled = process.env.WORKER_TRANSPORT_INTEGRATION === 'true';

const silent: StructuredLogger = {
  debug: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  info: () => undefined,
  trace: () => undefined,
  warn: () => undefined,
};

function named(connectionString: string | undefined, applicationName: string) {
  if (connectionString === undefined)
    throw new Error('Worker composition needs its database URLs');
  const url = new URL(connectionString);
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

/** Database sessions this worker process opened, found by their name. */
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
// with every runtime created from configuration. A refactor of the runtime
// seams must keep this path ready and fully closable.
describe.runIf(enabled)('worker production composition', () => {
  it('becomes ready and releases its database sessions on close', async () => {
    const applicationName = `worker-composition-${randomUUID()}`;
    const config = parseWorkerConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: named(process.env.DATABASE_URL, applicationName),
      DATABASE_MAINTENANCE_URL: named(
        process.env.DATABASE_MAINTENANCE_URL,
        applicationName,
      ),
    });
    const telemetry = {
      enabled: false,
      started: false,
      start: vi.fn(),
      shutdown: vi.fn(() => Promise.resolve()),
    } satisfies TelemetryLifecycle;
    const application = await createWorkerApplication(config, {
      logger: silent,
      telemetry,
    });
    let closed = false;
    try {
      await expect(
        application.get(WorkerReadiness).checkReadiness(),
      ).resolves.toBeUndefined();
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
});
