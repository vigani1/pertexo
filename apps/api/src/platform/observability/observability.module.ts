import type {
  DynamicModule,
  LoggerService,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Module } from '@nestjs/common';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';

export const STRUCTURED_LOGGER = Symbol('STRUCTURED_LOGGER');
export const TELEMETRY_LIFECYCLE = Symbol('TELEMETRY_LIFECYCLE');

export class NestLoggerAdapter implements LoggerService {
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

class TelemetryShutdown implements OnApplicationShutdown {
  public constructor(private readonly telemetry: TelemetryLifecycle) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.telemetry.shutdown();
  }
}

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ObservabilityModule {
  public static register(
    logger: StructuredLogger,
    telemetry: TelemetryLifecycle,
  ): DynamicModule {
    return {
      module: ObservabilityModule,
      providers: [
        { provide: STRUCTURED_LOGGER, useValue: logger },
        { provide: TELEMETRY_LIFECYCLE, useValue: telemetry },
        {
          provide: TelemetryShutdown,
          useFactory: () => new TelemetryShutdown(telemetry),
        },
      ],
      exports: [STRUCTURED_LOGGER, TELEMETRY_LIFECYCLE],
    };
  }
}
