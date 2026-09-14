import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';
import { describe, expect, it, vi } from 'vitest';

import { bootstrapApi, type ApiBootstrapModules } from '../src/main.js';
import { parseApiConfig } from '../src/platform/config/api-config.js';

const config = parseApiConfig({
  DATABASE_API_URL: 'postgresql://api:secret@localhost:5432/pertexo',
  HOST: '127.0.0.1',
  NODE_ENV: 'test',
  PORT: '4312',
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
      return telemetry.shutdown();
    }),
    listen: vi.fn(() => {
      events.push('application.listen');
      return Promise.resolve();
    }),
  };
  const createStructuredLogger = vi.fn(() => {
    events.push('logger.create');
    return logger;
  });
  const createApiApplication = vi.fn(() => {
    events.push('application.create');
    return Promise.resolve(application);
  });
  const modules = {
    application: { createApiApplication },
    logging: { createStructuredLogger },
  } as unknown as ApiBootstrapModules;
  const loadModules = vi.fn(() => {
    events.push('modules.load');
    return Promise.resolve(modules);
  });

  return {
    application,
    createApiApplication,
    createStructuredLogger,
    events,
    loadModules,
    logger,
    modules,
    telemetry,
  };
}

describe('API main bootstrap', () => {
  it('starts telemetry before loading instrumented modules and listens once', async () => {
    const fixture = createFixture();

    await expect(
      bootstrapApi({
        config,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
      }),
    ).resolves.toBeUndefined();

    expect(fixture.events).toEqual([
      'telemetry.start',
      'modules.load',
      'logger.create',
      'application.create',
      'application.listen',
      'logger.info',
    ]);
    expect(fixture.application.listen).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 4312,
    });
    expect(fixture.application.close).not.toHaveBeenCalled();
    expect(fixture.telemetry.shutdown).not.toHaveBeenCalled();
  });

  it('cleans telemetry when startup fails before module loading', async () => {
    const fixture = createFixture();
    const failure = new Error('telemetry start failed');
    fixture.telemetry.start.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(
      bootstrapApi({
        config,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
      }),
    ).rejects.toBe(failure);

    expect(fixture.loadModules).not.toHaveBeenCalled();
    expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
  });

  it.each(['modules', 'logger', 'application', 'listen'] as const)(
    'preserves a %s failure and closes only acquired owners',
    async (boundary) => {
      const fixture = createFixture();
      const failure = new Error(`${boundary} failed`);
      if (boundary === 'modules') {
        fixture.loadModules.mockRejectedValueOnce(failure);
      } else if (boundary === 'logger') {
        fixture.createStructuredLogger.mockImplementation(() => {
          throw failure;
        });
      } else if (boundary === 'application') {
        fixture.createApiApplication.mockRejectedValueOnce(failure);
      } else {
        fixture.application.listen.mockRejectedValueOnce(failure);
      }

      await expect(
        bootstrapApi({
          config,
          createTelemetryLifecycle: () => fixture.telemetry,
          loadModules: fixture.loadModules,
        }),
      ).rejects.toBe(failure);

      expect(fixture.application.close).toHaveBeenCalledTimes(
        boundary === 'listen' ? 1 : 0,
      );
      expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
    },
  );

  it('contains fatal and cleanup logging failures while preserving listen failure', async () => {
    const fixture = createFixture();
    const failure = new Error('listen failed');
    fixture.application.listen.mockRejectedValueOnce(failure);
    fixture.application.close.mockImplementationOnce(async () => {
      await fixture.telemetry.shutdown().catch(() => undefined);
      throw new Error('application close failed');
    });
    fixture.telemetry.shutdown.mockRejectedValueOnce(
      new Error('telemetry shutdown failed'),
    );
    fixture.logger.fatal.mockImplementationOnce(() => {
      throw new Error('fatal logger failed');
    });
    fixture.logger.error.mockImplementation(() => {
      throw new Error('cleanup logger failed');
    });

    await expect(
      bootstrapApi({
        config,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
      }),
    ).rejects.toBe(failure);

    expect(fixture.application.close).toHaveBeenCalledOnce();
    expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
    expect(fixture.logger.fatal).toHaveBeenCalledWith(
      'api.bootstrap_failed',
      { errorType: 'Error' },
      failure,
    );
    expect(fixture.logger.error).toHaveBeenCalledOnce();
  });

  it('reports telemetry cleanup failure without replacing application creation failure', async () => {
    const fixture = createFixture();
    const failure = new Error('application creation failed');
    const shutdownFailure = new Error('telemetry shutdown failed');
    fixture.createApiApplication.mockRejectedValueOnce(failure);
    fixture.telemetry.shutdown.mockRejectedValueOnce(shutdownFailure);

    await expect(
      bootstrapApi({
        config,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
      }),
    ).rejects.toBe(failure);

    expect(fixture.application.close).not.toHaveBeenCalled();
    expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
    expect(fixture.logger.error).toHaveBeenCalledWith(
      'telemetry.shutdown_failed',
      {},
      shutdownFailure,
    );
  });
});
