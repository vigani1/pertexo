import type { StructuredLogger } from './logger.js';
import type { TelemetryLifecycle } from './telemetry.js';

export class NestLoggerAdapter {
  public constructor(private readonly logger: StructuredLogger) {}

  public debug(message: unknown, ...optional: unknown[]): void {
    this.logger.debug('nest.debug', this.fields(message, optional));
  }

  public error(message: unknown, ...optional: unknown[]): void {
    this.logger.error(
      'nest.error',
      this.fields(message, optional),
      message instanceof Error ? message : undefined,
    );
  }

  public fatal(message: unknown, ...optional: unknown[]): void {
    this.logger.fatal(
      'nest.fatal',
      this.fields(message, optional),
      message instanceof Error ? message : undefined,
    );
  }

  public log(message: unknown, ...optional: unknown[]): void {
    this.logger.info('nest.log', this.fields(message, optional));
  }

  public verbose(message: unknown, ...optional: unknown[]): void {
    this.logger.trace('nest.verbose', this.fields(message, optional));
  }

  public warn(message: unknown, ...optional: unknown[]): void {
    this.logger.warn('nest.warn', this.fields(message, optional));
  }

  private fields(
    message: unknown,
    optional: readonly unknown[],
  ): Readonly<Record<string, unknown>> {
    const context = optional.findLast((value) => typeof value === 'string');
    return {
      messageType: message instanceof Error ? 'error' : typeof message,
      ...(typeof context === 'string' ? { context } : {}),
    };
  }
}

export class TelemetryShutdown {
  public constructor(private readonly telemetry: TelemetryLifecycle) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.telemetry.shutdown();
  }
}

export function createNestObservabilityRegistration<ModuleToken>(input: {
  module: ModuleToken;
  loggerToken: symbol;
  telemetryToken: symbol;
  logger: StructuredLogger;
  telemetry: TelemetryLifecycle;
}) {
  return {
    module: input.module,
    providers: [
      { provide: input.loggerToken, useValue: input.logger },
      { provide: input.telemetryToken, useValue: input.telemetry },
      {
        provide: TelemetryShutdown,
        useFactory: () => new TelemetryShutdown(input.telemetry),
      },
    ],
    exports: [input.loggerToken, input.telemetryToken],
  };
}
