import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import pino from 'pino';
import type { DestinationStream, Logger as PinoLogger } from 'pino';

import './server-only.js';

import type { ObservabilityConfig } from './config.js';

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

const RESERVED_FIELDS = new Set([
  'environment',
  'event',
  'level',
  'msg',
  'serviceName',
  'serviceVersion',
  'spanId',
  'time',
  'traceId',
]);

const MAX_SANITIZE_DEPTH = 12;
const MAX_SANITIZE_ENTRIES = 100;
const MAX_REDACT_TEXT_LENGTH = 16_384;
const REDACTED = '[Redacted]';
const TRUNCATED = '[Truncated]';
const eventNamePattern = /^[a-z][a-z0-9_.:-]{0,127}$/u;

const SECRET_NAMES = [
  'accessToken',
  'apiKey',
  'api_key',
  'clientSecret',
  'credential',
  'password',
  'refreshToken',
  'secret',
  'token',
] as const;

const SECRET_NORMALIZED_NAMES = new Set([
  ...SECRET_NAMES.map((name) => name.toLowerCase()),
  'authorization',
  'cookie',
  'setcookie',
]);

const SECRET_PATHS = SECRET_NAMES.flatMap((name) => [
  name,
  `*.${name}`,
  `*.*.${name}`,
  `*.*.*.${name}`,
]);

const REDACT_PATHS = [
  ...SECRET_PATHS,
  'authorization',
  'Authorization',
  'cookie',
  'set-cookie',
  'headers.authorization',
  'headers.Authorization',
  'headers.cookie',
  'headers.set-cookie',
  'req.headers.authorization',
  'req.headers.Authorization',
  'req.headers.cookie',
  'req.headers.set-cookie',
  'request.headers.authorization',
  'request.headers.Authorization',
  'request.headers.cookie',
  'request.headers.set-cookie',
];

type LogMethod = 'debug' | 'error' | 'fatal' | 'info' | 'trace' | 'warn';

function isSchemeCharacter(character: string): boolean {
  const code = character.codePointAt(0);
  return (
    code !== undefined &&
    ((code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      character === '+' ||
      character === '-' ||
      character === '.')
  );
}

function isAsciiLetter(character: string): boolean {
  const code = character.codePointAt(0);
  return (
    code !== undefined &&
    ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))
  );
}

function isAuthorityBoundary(character: string): boolean {
  return (
    character === '/' ||
    character === '?' ||
    character === '#' ||
    character === ' ' ||
    character === '\t' ||
    character === '\r' ||
    character === '\n'
  );
}

function redactUrlUserInfo(value: string): string {
  let copyFrom = 0;
  let searchFrom = 0;
  let result = '';
  while (searchFrom < value.length) {
    const separator = value.indexOf('://', searchFrom);
    if (separator === -1) break;
    let schemeStart = separator;
    while (schemeStart > 0 && isSchemeCharacter(value[schemeStart - 1] ?? ''))
      schemeStart -= 1;
    if (!isAsciiLetter(value[schemeStart] ?? '')) {
      searchFrom = separator + 3;
      continue;
    }
    const authorityStart = separator + 3;
    let authorityEnd = authorityStart;
    while (
      authorityEnd < value.length &&
      !isAuthorityBoundary(value[authorityEnd] ?? '')
    )
      authorityEnd += 1;
    const at = value.indexOf('@', authorityStart);
    const colon = value.indexOf(':', authorityStart);
    if (at >= authorityStart && at < authorityEnd && colon >= 0 && colon < at) {
      result += `${value.slice(copyFrom, colon + 1)}${REDACTED}`;
      copyFrom = at;
      searchFrom = at + 1;
    } else {
      searchFrom = authorityEnd + 1;
    }
  }
  return result + value.slice(copyFrom);
}

function boundText(value: string): string {
  if (value.length <= MAX_REDACT_TEXT_LENGTH) return value;
  const prefix = value.slice(0, MAX_REDACT_TEXT_LENGTH);
  const safeEnd = Math.max(
    prefix.lastIndexOf(' '),
    prefix.lastIndexOf('\t'),
    prefix.lastIndexOf('\r'),
    prefix.lastIndexOf('\n'),
  );
  return `${safeEnd < 0 ? '' : prefix.slice(0, safeEnd + 1)}${TRUNCATED}`;
}

export function redactLogText(value: string): string {
  return redactUrlUserInfo(boundText(value))
    .replace(
      /(authorization\s*[:=]\s*(?:(?:basic|bearer)\s+)?)[^\s,;]+/giu,
      `$1${REDACTED}`,
    )
    .replace(/((?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/giu, `$1${REDACTED}`)
    .replace(/((?:basic|bearer)\s+)[^\s"',;]+/giu, `$1${REDACTED}`)
    .replace(
      /((?:access[_-]?token|api[_-]?key|client[_-]?secret|credentials?|password|refresh[_-]?token|secret|token)\s*["']?\s*[:=]\s*["']?)([^&\s,;"'}]+)/giu,
      `$1${REDACTED}`,
    );
}

function safeEventName(event: LogEventName): LogEventName {
  return eventNamePattern.test(event) ? event : 'log.invalid_event';
}

function isSecretName(name: string): boolean {
  const normalized = name.replaceAll(/[^a-z0-9]/giu, '').toLowerCase();
  return (
    SECRET_NORMALIZED_NAMES.has(normalized) ||
    /(?:access|auth|bearer|refresh|session|id)token$/u.test(normalized) ||
    /(?:api|private|signing|encryption|secret|client)key$/u.test(normalized) ||
    /(?:password|secret|credential)$/u.test(normalized)
  );
}

function sanitizeError(
  error: Error,
  depth: number,
  seen: WeakSet<object>,
): Error {
  try {
    if (seen.has(error)) {
      return new Error('[Circular error]');
    }
    seen.add(error);

    const cause =
      'cause' in error
        ? sanitizeValue(error.cause, depth + 1, seen)
        : undefined;
    const sanitized =
      cause === undefined
        ? new Error(redactLogText(error.message))
        : new Error(redactLogText(error.message), { cause });
    sanitized.name = error.name;
    if (error.stack !== undefined) {
      sanitized.stack = redactLogText(error.stack);
    }
    return sanitized;
  } catch {
    return new Error('[Unserializable error]');
  }
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    return redactLogText(value);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (depth >= MAX_SANITIZE_DEPTH) {
    return TRUNCATED;
  }
  if (value instanceof Error) {
    return sanitizeError(value, depth, seen);
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_SANITIZE_ENTRIES)
      .map((item) => sanitizeValue(item, depth + 1, seen));
  }

  return sanitizeRecord(value, depth, seen);
}

function sanitizeRecord(
  value: object,
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> | string {
  let entries: readonly [string, unknown][];
  try {
    entries = Object.entries(value).slice(0, MAX_SANITIZE_ENTRIES);
  } catch {
    return '[Unserializable]';
  }

  return Object.fromEntries(
    entries.map(([key, entryValue]) => [
      key,
      isSecretName(key) ? REDACTED : sanitizeValue(entryValue, depth + 1, seen),
    ]),
  );
}

function safeFields(fields: LogFields | undefined): Record<string, unknown> {
  if (fields === undefined) {
    return {};
  }

  try {
    const selected = Object.fromEntries(
      Object.entries(fields).filter(([key]) => !RESERVED_FIELDS.has(key)),
    );
    const sanitized = sanitizeRecord(selected, 0, new WeakSet());
    return typeof sanitized === 'string' ? {} : sanitized;
  } catch {
    return {};
  }
}

function errorValue(error: unknown): Error | undefined {
  if (error === undefined) {
    return undefined;
  }

  if (error instanceof Error) {
    return sanitizeError(error, 0, new WeakSet());
  }

  return new Error('Non-Error value thrown', {
    cause: sanitizeValue(error, 0, new WeakSet()),
  });
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
    redact: {
      censor: '[Redacted]',
      paths: REDACT_PATHS,
    },
    serializers: {
      err: pino.stdSerializers.errWithCause,
    },
  } as const;

  const logger =
    destination === undefined ? pino(options) : pino(options, destination);
  return new PinoStructuredLogger(logger);
}
