import { randomUUID } from 'node:crypto';

import type { StructuredLogger } from '@pertexo/observability/logging';
import type { TelemetryLifecycle } from '@pertexo/observability/telemetry';
import { describe, expect, it, vi } from 'vitest';

import { parseOperatorCommandConfig } from '../src/config.js';
import {
  bootstrapOperatorCommand,
  type OperatorCommandBootstrapModules,
} from '../src/main.js';

const config = parseOperatorCommandConfig({
  DATABASE_OPERATOR_URL: 'postgresql://operator:secret@localhost:5432/pertexo',
  NODE_ENV: 'test',
  OPERATOR_ACTOR_REF: 'main-test',
  OPERATOR_COMMAND_ID: randomUUID(),
  OPERATOR_COMMAND_TYPE: 'operator.status',
  OPERATOR_REASON: 'test bootstrap ownership',
  OPERATOR_WORKSPACE_ID: randomUUID(),
});

function processDouble() {
  const listeners = new Map<string, () => void>();
  return {
    emit(signal: 'SIGINT' | 'SIGTERM') {
      listeners.get(signal)?.();
    },
    once: vi.fn((signal: string, listener: () => void) => {
      listeners.set(signal, listener);
    }),
    removeListener: vi.fn((signal: string, listener: () => void) => {
      if (listeners.get(signal) === listener) listeners.delete(signal);
    }),
    stdout: { write: vi.fn() },
  };
}

function createFixture() {
  const process = processDouble();
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  } satisfies StructuredLogger;
  const telemetry = {
    enabled: false,
    get started() {
      return true;
    },
    shutdown: vi.fn(() => Promise.resolve()),
    start: vi.fn(),
  } satisfies TelemetryLifecycle;
  const database = { close: vi.fn(() => Promise.resolve()) };
  const result = { commandId: config.command.commandId, status: 'missing' };
  type RunInput = Parameters<
    OperatorCommandBootstrapModules['command']['runOperatorCommand']
  >[0];
  const runOperatorCommand = vi.fn((_input: RunInput) => {
    void _input;
    return Promise.resolve(result as never);
  });
  const createOperatorCommandDatabase = vi.fn(() => database);
  const createStructuredLogger = vi.fn(() => logger);
  const modules = {
    command: { runOperatorCommand },
    database: { createOperatorCommandDatabase },
    logging: { createStructuredLogger },
  } as unknown as OperatorCommandBootstrapModules;
  const loadModules = vi.fn(() => Promise.resolve(modules));
  return {
    createOperatorCommandDatabase,
    createStructuredLogger,
    database,
    loadModules,
    logger,
    process,
    result,
    runOperatorCommand,
    telemetry,
  };
}

describe('operator command main bootstrap', () => {
  it('hands a complete command to the runner and writes one JSON result', async () => {
    const fixture = createFixture();

    await expect(
      bootstrapOperatorCommand({
        config,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
        process: fixture.process,
      }),
    ).resolves.toBeUndefined();

    expect(fixture.runOperatorCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanupTimeoutMs: 10_000,
        command: config.command,
        database: fixture.database,
        logger: fixture.logger,
        telemetry: fixture.telemetry,
      }),
    );
    expect(fixture.runOperatorCommand.mock.calls[0]?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(fixture.process.stdout.write).toHaveBeenCalledWith(
      `${JSON.stringify(fixture.result)}\n`,
    );
    expect(fixture.database.close).not.toHaveBeenCalled();
    expect(fixture.telemetry.shutdown).not.toHaveBeenCalled();
    expect(fixture.process.removeListener).toHaveBeenCalledTimes(2);
  });

  it.each(['telemetry', 'modules', 'logger', 'database'] as const)(
    'preserves a %s failure and cleans every acquired pre-handoff owner',
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
        fixture.createStructuredLogger.mockImplementationOnce(() => {
          throw failure;
        });
      } else {
        fixture.createOperatorCommandDatabase.mockImplementationOnce(() => {
          throw failure;
        });
      }

      await expect(
        bootstrapOperatorCommand({
          config,
          createTelemetryLifecycle: () => fixture.telemetry,
          loadModules: fixture.loadModules,
          process: fixture.process,
        }),
      ).rejects.toBe(failure);

      expect(fixture.database.close).not.toHaveBeenCalled();
      expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
      expect(fixture.process.removeListener).toHaveBeenCalledTimes(2);
    },
  );

  it('does not duplicate cleanup after the command runner takes ownership', async () => {
    const fixture = createFixture();
    const failure = new Error('owned runner failed');
    fixture.runOperatorCommand.mockRejectedValueOnce(failure);

    await expect(
      bootstrapOperatorCommand({
        config,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
        process: fixture.process,
      }),
    ).rejects.toBe(failure);

    expect(fixture.database.close).not.toHaveBeenCalled();
    expect(fixture.telemetry.shutdown).not.toHaveBeenCalled();
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'composes %s into the runner signal and removes both listeners',
    async (signal) => {
      const fixture = createFixture();
      const entered = Promise.withResolvers<AbortSignal>();
      fixture.runOperatorCommand.mockImplementationOnce(({ signal }) => {
        entered.resolve(signal);
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error('Operator command test signal was aborted', {
                      cause: signal.reason,
                    }),
              );
            },
            { once: true },
          );
        });
      });

      const running = bootstrapOperatorCommand({
        config,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
        process: fixture.process,
      });
      await entered.promise;
      fixture.process.emit(signal);

      await expect(running).rejects.toMatchObject({
        message: 'Operator command interrupted',
      });
      expect(fixture.process.removeListener).toHaveBeenCalledTimes(2);
      expect(fixture.database.close).not.toHaveBeenCalled();
      expect(fixture.telemetry.shutdown).not.toHaveBeenCalled();
    },
  );

  it('contains fatal diagnostics and still attempts database and telemetry cleanup', async () => {
    const fixture = createFixture();
    const failure = new Error('post-database setup failed');
    const hostileConfig = new Proxy(config, {
      get(target, property, receiver) {
        if (property === 'command') throw failure;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    fixture.database.close.mockRejectedValueOnce(new Error('close failed'));
    fixture.logger.fatal.mockImplementationOnce(() => {
      throw new Error('fatal failed');
    });
    fixture.telemetry.shutdown.mockRejectedValueOnce(
      new Error('telemetry failed'),
    );

    await expect(
      bootstrapOperatorCommand({
        config: hostileConfig,
        createTelemetryLifecycle: () => fixture.telemetry,
        loadModules: fixture.loadModules,
        process: fixture.process,
      }),
    ).rejects.toBe(failure);

    expect(fixture.database.close).toHaveBeenCalledOnce();
    expect(fixture.telemetry.shutdown).toHaveBeenCalledOnce();
    expect(fixture.process.removeListener).toHaveBeenCalledTimes(2);
  });
});
