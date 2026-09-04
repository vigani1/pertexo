import { redactLogText, type StructuredLogger } from './logger.js';
import type { TelemetryLifecycle } from './telemetry.js';

export class NestLoggerAdapter {
  public constructor(private readonly logger: StructuredLogger) {}

  public debug(message: unknown, ...optional: unknown[]): void {
    this.logger.debug('nest.debug', this.fields(message, optional));
  }

  public error(message: unknown, ...optional: unknown[]): void {
    const normalized = this.normalize(message, optional);
    this.logger.error('nest.error', normalized.fields, normalized.error);
  }

  public fatal(message: unknown, ...optional: unknown[]): void {
    const normalized = this.normalize(message, optional);
    this.logger.fatal('nest.fatal', normalized.fields, normalized.error);
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
    return this.normalize(message, optional).fields;
  }

  private normalize(message: unknown, optional: readonly unknown[]) {
    const strings = optional.filter(
      (value): value is string => typeof value === 'string',
    );
    const onlyString = strings.length === 1 ? strings[0] : undefined;
    const onlyStringIsStack =
      onlyString !== undefined && resemblesStack(onlyString);
    const context =
      strings.length > 1
        ? strings.at(-1)
        : onlyStringIsStack
          ? undefined
          : onlyString;
    const stack =
      strings.length > 1
        ? strings.at(-2)
        : onlyStringIsStack
          ? onlyString
          : undefined;
    const summary =
      typeof message === 'string' ? boundedNestText(message) : undefined;
    return {
      fields: {
        messageType: message instanceof Error ? 'error' : typeof message,
        ...(summary === undefined ? {} : { summary }),
        ...(context === undefined ? {} : { context: boundedNestText(context) }),
      },
      error:
        message instanceof Error
          ? message
          : summary !== undefined && stack !== undefined
            ? nestError(summary, stack)
            : undefined,
    };
  }
}

const MAX_NEST_TEXT_LENGTH = 1_024;

function boundedNestText(value: string): string {
  const bounded =
    value.length <= MAX_NEST_TEXT_LENGTH
      ? value
      : `${value.slice(0, MAX_NEST_TEXT_LENGTH)}[Truncated]`;
  return redactLogText(bounded);
}

function nestError(summary: string, stack: string): Error {
  const error = new Error(summary);
  error.stack = boundedNestText(stack);
  return error;
}

function resemblesStack(value: string): boolean {
  return /(?:^|\n)\s*(?:[A-Za-z]*Error\b|at\s+\S+)/u.test(value);
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
