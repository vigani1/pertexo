import { describe, expect, it, vi } from 'vitest';

import {
  createNestObservabilityRegistration,
  NestLoggerAdapter,
  TelemetryShutdown,
} from '../src/nest-runtime.js';
import type { StructuredLogger } from '../src/logger.js';
import type { TelemetryLifecycle } from '../src/telemetry.js';

describe('Nest observability runtime integration', () => {
  it('adapts bounded Nest log context without forwarding message content', () => {
    const errorLog = vi.fn();
    const logger = loggerFixture({ error: errorLog });
    const adapter = new NestLoggerAdapter(logger);
    const secret = new Error('must not become a structured field');
    adapter.error(secret, 'ignored', 'WorkflowModule');
    expect(errorLog).toHaveBeenCalledWith(
      'nest.error',
      { messageType: 'error', context: 'WorkflowModule' },
      secret,
    );
  });

  it.each([
    ['debug', 'debug', 'nest.debug'],
    ['log', 'info', 'nest.log'],
    ['verbose', 'trace', 'nest.verbose'],
    ['warn', 'warn', 'nest.warn'],
  ] as const)(
    'preserves a safe summary and context for %s',
    (adapterMethod, loggerMethod, event) => {
      const write = vi.fn();
      const adapter = new NestLoggerAdapter(
        loggerFixture({ [loggerMethod]: write }),
      );

      adapter[adapterMethod]('Started with Bearer top-secret', 'RuntimeModule');

      expect(write).toHaveBeenCalledWith(event, {
        context: 'RuntimeModule',
        messageType: 'string',
        summary: 'Started with Bearer [Redacted]',
      });
    },
  );

  it.each(['error', 'fatal'] as const)(
    'normalizes the documented message/stack/context %s shape',
    (level) => {
      const write = vi.fn();
      const adapter = new NestLoggerAdapter(loggerFixture({ [level]: write }));
      adapter[level](
        'Bootstrap failed',
        'Error: Bootstrap failed\n    at bootstrap (main.ts:1:1)',
        'NestFactory',
      );

      expect(write).toHaveBeenCalledWith(
        `nest.${level}`,
        {
          context: 'NestFactory',
          messageType: 'string',
          summary: 'Bootstrap failed',
        },
        expect.objectContaining({ message: 'Bootstrap failed' }),
      );
    },
  );

  it('does not mistake a lone stack for context', () => {
    const write = vi.fn();
    const adapter = new NestLoggerAdapter(loggerFixture({ error: write }));
    adapter.error('Failed', 'Error: Failed\n    at run (worker.ts:2:3)');

    expect(write).toHaveBeenCalledWith(
      'nest.error',
      { messageType: 'string', summary: 'Failed' },
      expect.any(Error),
    );
  });

  it('bounds summaries and avoids inspecting object payloads', () => {
    const write = vi.fn();
    const adapter = new NestLoggerAdapter(loggerFixture({ info: write }));
    adapter.log('x'.repeat(2_000));
    adapter.log(
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('trap detail');
          },
        },
      ),
    );

    expect(write.mock.calls[0]?.[1]).toEqual({
      messageType: 'string',
      summary: `${'x'.repeat(1_024)}[Truncated]`,
    });
    expect(write.mock.calls[1]?.[1]).toEqual({ messageType: 'object' });
  });

  it('registers common tokens and delegates shutdown exactly once per hook', async () => {
    const logger = loggerFixture();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const telemetry = telemetryFixture(shutdown);
    const loggerToken = Symbol('logger');
    const telemetryToken = Symbol('telemetry');
    // Nest-compatible module token fixture.
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    class RuntimeModule {}
    const registration = createNestObservabilityRegistration({
      module: RuntimeModule,
      loggerToken,
      telemetryToken,
      logger,
      telemetry,
    });
    expect(registration.exports).toEqual([loggerToken, telemetryToken]);
    expect(registration.providers).toEqual(
      expect.arrayContaining([
        { provide: loggerToken, useValue: logger },
        { provide: telemetryToken, useValue: telemetry },
      ]),
    );
    const shutdownProvider = registration.providers.find(
      (provider) => provider.provide === TelemetryShutdown,
    );
    if (shutdownProvider === undefined || !('useFactory' in shutdownProvider))
      throw new Error('Telemetry shutdown provider is missing');
    await shutdownProvider.useFactory().onApplicationShutdown();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});

function loggerFixture(
  overrides: Partial<StructuredLogger> = {},
): StructuredLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

function telemetryFixture(shutdown: () => Promise<void>): TelemetryLifecycle {
  return {
    enabled: true,
    started: true,
    start: vi.fn(),
    shutdown,
  };
}
