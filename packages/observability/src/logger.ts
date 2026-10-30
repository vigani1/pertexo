import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import pino from 'pino';
import type { DestinationStream, Logger as PinoLogger } from 'pino';
import type { ObservabilityConfig } from './config.js';
import { safeFields, errorValue } from './logging/redaction.js';

export { redactLogText, redactCredentialFields } from './logging/redaction.js';
export type LogFields = Readonly<Record<string, unknown>>;

export type LogEventName = string;

export interface StructuredLogger {
  debug(event: LogEventName, fields?: LogFields, error?: unknown): void;
  error(event: LogEventName, fields?: LogFields, error?: unknown): void;
  fatal(event: LogEventName, fields?: LogFields, error?: unknown): void;
  info(event: LogEventName, fields?: LogFields, error?: unknown): void;
  trace(event: LogEventName, fields?: LogFields, error?: unknown): void;
  warn(event: LogEventName, fields?: LogFields, error?: unknown): void;
}

const eventNamePattern = /^[a-z][a-z0-9_.:-]{0,127}$/u;

type LogMethod = 'debug' | 'error' | 'fatal' | 'info' | 'trace' | 'warn';

function safeEventName(event: LogEventName): LogEventName {
  return eventNamePattern.test(event) ? event : 'log.invalid_event';
}

function correlationFields(): Readonly<Record<string, string>> {
  const span = trace.getSpan(context.active());
  if (span === undefined) {
    return {};
  }

  const spanContext = span.spanContext();
  if (!isSpanContextValid(spanContext)) {
    return {};
  }

  return {
    spanId: spanContext.spanId,
    traceId: spanContext.traceId,
  };
}

class PinoStructuredLogger implements StructuredLogger {
  public constructor(private readonly logger: PinoLogger) {}

  public debug(event: LogEventName, fields?: LogFields, error?: unknown): void {
    this.write('debug', event, fields, error);
  }

  public error(event: LogEventName, fields?: LogFields, error?: unknown): void {
    this.write('error', event, fields, error);
  }

  public fatal(event: LogEventName, fields?: LogFields, error?: unknown): void {
    this.write('fatal', event, fields, error);
  }

  public info(event: LogEventName, fields?: LogFields, error?: unknown): void {
    this.write('info', event, fields, error);
  }

  public trace(event: LogEventName, fields?: LogFields, error?: unknown): void {
    this.write('trace', event, fields, error);
  }

  public warn(event: LogEventName, fields?: LogFields, error?: unknown): void {
    this.write('warn', event, fields, error);
  }

  private write(
    level: LogMethod,
    event: LogEventName,
    fields: LogFields | undefined,
    error: unknown,
  ): void {
    const err = errorValue(error);
    const safeEvent = safeEventName(event);
    const record = {
      ...safeFields(fields),
      ...correlationFields(),
      event: safeEvent,
      ...(err === undefined ? {} : { err }),
    };

    this.logger[level](record, safeEvent);
  }
}

export function createStructuredLogger(
  config: ObservabilityConfig,
  destination?: DestinationStream,
): StructuredLogger {
  const options = {
    base: {
      environment: config.environment,
      serviceName: config.serviceName,
      serviceVersion: config.serviceVersion,
    },
    errorKey: 'err',
    level: config.logLevel,
    serializers: {
      err: pino.stdSerializers.errWithCause,
    },
  } as const;

  const logger =
    destination === undefined ? pino(options) : pino(options, destination);
  return new PinoStructuredLogger(logger);
}
