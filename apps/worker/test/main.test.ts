import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';
import { describe, expect, it, vi } from 'vitest';

import { parseWorkerConfig } from '../src/config/worker-config.js';
import { bootstrapWorker, type WorkerBootstrapModules } from '../src/main.js';

const config = parseWorkerConfig({
  DATABASE_DISPATCHER_URL:
    'postgresql://dispatcher:secret@localhost:5432/pertexo',
  DATABASE_WORKER_URL: 'postgresql://worker:secret@localhost:5432/pertexo',
  NODE_ENV: 'test',
  REDIS_URL: 'redis://:secret@localhost:6379/0',
});

function createFixture() {
  const events: string[] = [];
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(() => events.push('logger.info')),
    trace: vi.fn(),
    warn: vi.fn(),
  } satisfies StructuredLogger;
  const telemetry = {
    enabled: false,
    get started() {
      return true;
    },
    shutdown: vi.fn(() => {
      events.push('telemetry.shutdown');
      return Promise.resolve();
    }),
    start: vi.fn(() => events.push('telemetry.start')),
  } satisfies TelemetryLifecycle;
  const application = {
    close: vi.fn(() => {
      events.push('application.close');
      return Promise.resolve();
    }),
  };
  const owner = {
    close: vi.fn(() => {
      events.push('owner.close');
      return Promise.resolve();
    }),
    install: vi.fn(() => events.push('owner.install')),
  };
  const createStructuredLogger = vi.fn(() => {
    events.push('logger.create');
    return logger;
  });
  const createWorkerApplication = vi.fn(() => {
    events.push('application.create');
    return Promise.resolve(application);
  });
  const modules = {
    application: { createWorkerApplication },
    logging: { createStructuredLogger },
  } as unknown as WorkerBootstrapModules;
  const loadModules = vi.fn(() => {
    events.push('modules.load');
    return Promise.resolve(modules);
  });
  const createShutdownOwner = vi.fn(() => {
    events.push('owner.create');
    return owner;
  });

  return {
    application,
    createShutdownOwner,
    createStructuredLogger,
    createWorkerApplication,
    events,
    loadModules,
    logger,
    owner,
    telemetry,
  };
}

describe('worker main bootstrap', () => {
  it('starts telemetry before instrumented imports and installs one shutdown owner', async () => {
    const fixture = createFixture();

    await expect(
      bootstrapWorker({
        config,
        createShutdownOwner: fixture.createShutdownOwner,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
      }),
    ).resolves.toBeUndefined();

    expect(fixture.events).toEqual([
      'telemetry.start',
      'modules.load',
      'logger.create',
      'application.create',
      'owner.create',
      'owner.install',
      'logger.info',
    ]);
    expect(fixture.owner.close).not.toHaveBeenCalled();
    expect(fixture.application.close).not.toHaveBeenCalled();
    expect(fixture.telemetry.shutdown).not.toHaveBeenCalled();
  });

  it.each([
    'telemetry',
    'modules',
    'logger',
    'application',
    'owner-construction',
    'owner-install',
    'startup-log',
  ] as const)(
    'preserves a %s startup failure and closes through the acquired owner',
    async (boundary) => {
      const fixture = createFixture();
      const failure = new Error(`${boundary} failed`);
      if (boundary === 'telemetry') {
        fixture.telemetry.start.mockImplementationOnce(() => {
          throw failure;
        });
      } else if (boundary === 'modules') {
        fixture.loadModules.mockRejectedValueOnce(failure);
      } else if (boundary === 'logger') {
        fixture.createStructuredLogger.mockImplementation(() => {
          throw failure;
        });
      } else if (boundary === 'application') {
        fixture.createWorkerApplication.mockRejectedValueOnce(failure);
      } else if (boundary === 'owner-construction') {
        fixture.createShutdownOwner.mockImplementationOnce(() => {
          throw failure;
        });
      } else if (boundary === 'owner-install') {
        fixture.owner.install.mockImplementationOnce(() => {
          throw failure;
        });
      } else {
        fixture.logger.info.mockImplementationOnce(() => {
          throw failure;
        });
      }

      await expect(
        bootstrapWorker({
          config,
          createShutdownOwner: fixture.createShutdownOwner,
          createTelemetryLifecycle: () => fixture.telemetry,
          loadModules: fixture.loadModules,
        }),
      ).rejects.toBe(failure);

      const applicationAcquired = [
        'owner-construction',
        'owner-install',
        'startup-log',
      ].includes(boundary);
      const ownerAcquired = ['owner-install', 'startup-log'].includes(boundary);
      expect(fixture.owner.close).toHaveBeenCalledTimes(ownerAcquired ? 1 : 0);
      expect(fixture.application.close).toHaveBeenCalledTimes(
        applicationAcquired && !ownerAcquired ? 1 : 0,
      );
      expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
    },
  );

  it('contains throwing diagnostics and continues from owner cleanup to telemetry', async () => {
    const fixture = createFixture();
    const failure = new Error('startup log failed');
    fixture.logger.info.mockImplementationOnce(() => {
      throw failure;
    });
    fixture.logger.fatal.mockImplementationOnce(() => {
      throw new Error('fatal log failed');
    });
    fixture.owner.close.mockRejectedValueOnce(new Error('owner close failed'));
    fixture.logger.error.mockImplementation(() => {
      throw new Error('cleanup log failed');
    });
    fixture.telemetry.shutdown.mockRejectedValueOnce(
      new Error('telemetry shutdown failed'),
    );

    await expect(
      bootstrapWorker({
        config,
        createShutdownOwner: fixture.createShutdownOwner,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
      }),
    ).rejects.toBe(failure);

    expect(fixture.owner.close).toHaveBeenCalledOnce();
    expect(fixture.application.close).not.toHaveBeenCalled();
    expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
    expect(fixture.logger.error).toHaveBeenCalledTimes(2);
  });
});
