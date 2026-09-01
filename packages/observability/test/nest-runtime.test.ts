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
