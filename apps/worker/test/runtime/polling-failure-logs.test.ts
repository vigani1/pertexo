import { Test } from '@nestjs/testing';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseWorkerConfig } from '../../src/config/worker.js';
import { WORKSPACE_INBOX_RUNTIME } from '../../src/notifications/inbox-runtime.js';
import { SYSTEM_MAIL_RUNTIME } from '../../src/mail/system-mail.runtime.js';
import { configuredRetentionRuntime } from '../../src/retention/composition.js';
import { RETENTION_RUNTIME } from '../../src/retention/retention.runtime.js';
import {
  configuredStalledWorkRuntime,
  STALLED_WORK_RUNTIME,
} from '../../src/runs/stalled-work.js';
import type { PollingRuntime } from '../../src/runtime/polling.js';
import {
  COORDINATOR_RUNTIME,
  MAINTENANCE_RUNTIME,
  NODE_ATTEMPT_RUNTIME,
  TRIGGER_RUNTIME,
} from '../../src/transport/transport.module.js';
import { configuredWorkflowAutoPauseRuntime } from '../../src/workflows/auto-pause-provider.js';
import { WORKFLOW_AUTO_PAUSE_RUNTIME } from '../../src/workflows/auto-pause-runtime.js';
import { WorkerModule } from '../../src/worker.module.js';
import { workerEnvironment } from '../support/worker-environment.js';

// Nothing listens here, so every loop fails the way a real outage makes it fail.
const UNREACHABLE = '127.0.0.1:1';

const config = parseWorkerConfig({
  ...workerEnvironment,
  DATABASE_URL: `postgresql://pertexo_app:secret@${UNREACHABLE}/pertexo?connect_timeout=1`,
  DATABASE_MAINTENANCE_URL: `postgresql://pertexo_maintenance:secret@${UNREACHABLE}/pertexo?connect_timeout=1`,
  REDIS_URL: `redis://${UNREACHABLE}/0`,
  ARTIFACT_STORE_ENDPOINT: `http://${UNREACHABLE}`,
  AUTH_MAIL_EMAIL_API_KEY: 'unused',
  AUTH_MAIL_KEY: Buffer.alloc(32, 4).toString('base64'),
  AUTH_MAIL_KEY_VERSION: 'mail-v1',
});

const fakeLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const refused: unknown = expect.objectContaining({ code: 'ECONNREFUSED' });

/** The worker's real wiring, without the queue consumers it would also start. */
async function moduleRuntime(
  token: symbol,
  logger: ReturnType<typeof fakeLogger>,
) {
  const telemetry = {
    enabled: false,
    started: false,
    start: vi.fn(),
    shutdown: vi.fn(() => Promise.resolve()),
  } satisfies TelemetryLifecycle;
  const idle = {
    consumer: { hasStopped: () => false },
    start: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
  };
  let builder = Test.createTestingModule({
    imports: [
      WorkerModule.register(config, {
        logger: logger as unknown as StructuredLogger,
        telemetry,
      }),
    ],
  });
  for (const runtime of [
    COORDINATOR_RUNTIME,
    NODE_ATTEMPT_RUNTIME,
    MAINTENANCE_RUNTIME,
    TRIGGER_RUNTIME,
    STALLED_WORK_RUNTIME,
    RETENTION_RUNTIME,
    WORKFLOW_AUTO_PAUSE_RUNTIME,
  ])
    if (runtime !== token)
      builder = builder.overrideProvider(runtime).useValue(idle);
  const module = await builder.compile();
  return {
    runtime: module.get<PollingRuntime>(token, { strict: false }),
    close: () => module.close(),
  };
}

describe('what a polling loop logs when a cycle fails', () => {
  const closers: (() => Promise<unknown>)[] = [];

  afterEach(async () => {
    await Promise.allSettled(closers.splice(0).map((close) => close()));
  });

  const failsOnce = async (runtime: PollingRuntime) => {
    closers.push(() => runtime.close());
    runtime.start();
    await expect(runtime.checkReadiness()).rejects.toThrow(
      /cycle failed|not ready/u,
    );
  };

  it('stalled work says why, per stage and for the cycle', async () => {
    const logger = fakeLogger();
    const runtime = configuredStalledWorkRuntime(
      config,
      logger as unknown as StructuredLogger,
      { attempts: { hasStopped: () => true } },
    );

    await failsOnce(runtime);

    for (const stage of [
      'expired_leases',
      'overdue_deliveries',
      'failed_run_jobs',
      'undated_deliveries',
    ])
      expect(logger.error).toHaveBeenCalledWith(
        'run_recovery.stage_failed',
        { stage },
        refused,
      );
    expect(logger.error).toHaveBeenCalledWith(
      'run_recovery.scan_failed',
      {},
      refused,
    );
  });

  it('retention says why', async () => {
    const logger = fakeLogger();
    const runtime = configuredRetentionRuntime(
      config,
      logger as unknown as StructuredLogger,
    );

    await failsOnce(runtime);

    expect(logger.error).toHaveBeenCalledWith(
      'retention.cycle_failed',
      {},
      refused,
    );
  });

  it('workflow auto-pause says why', async () => {
    const logger = fakeLogger();
    const runtime = configuredWorkflowAutoPauseRuntime(config, {
      logger: logger as unknown as StructuredLogger,
    });

    await failsOnce(runtime);

    expect(logger.error).toHaveBeenCalledWith(
      'workflow_auto_pause.cycle_failed',
      {},
      refused,
    );
  });

  it('the workspace inbox says why', async () => {
    const logger = fakeLogger();
    const { runtime, close } = await moduleRuntime(
      WORKSPACE_INBOX_RUNTIME,
      logger,
    );
    closers.push(close);

    await failsOnce(runtime);

    expect(logger.error).toHaveBeenCalledWith(
      'workspace_inbox.cycle_failed',
      {},
      refused,
    );
  });

  it('system mail says why', async () => {
    const logger = fakeLogger();
    const { runtime, close } = await moduleRuntime(SYSTEM_MAIL_RUNTIME, logger);
    closers.push(close);

    await failsOnce(runtime);

    expect(logger.error).toHaveBeenCalledWith(
      'system_mail.delivery_cycle_failed',
      {},
      refused,
    );
  });
});
