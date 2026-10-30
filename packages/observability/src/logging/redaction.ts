import type { LogFields } from '../logger.js';

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

const MAX_SANITIZE_TOTAL_ENTRIES = 500;

const MAX_REDACT_TEXT_LENGTH = 16_384;

const REDACTED = '[Redacted]';

const TRUNCATED = '[Truncated]';

const SECRET_NAMES = [
  'accessToken',
  'apiKey',
  'api_key',
  'clientSecret',
  'credential',
  'capability',
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
  'xpertexoformkey',
  'xpertexounsubscribekey',
]);

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
    const hasUrlUserInfo =
      at >= authorityStart && at < authorityEnd && colon >= 0 && colon < at;
    if (hasUrlUserInfo) {
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
    .replace(/(\/hooks\/)[^\s/\x22\x27?#]+/gu, `$1${REDACTED}`)
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

function isSecretName(name: string): boolean {
  const normalized = name.replaceAll(/[^a-z0-9]/giu, '').toLowerCase();
  return (
    SECRET_NORMALIZED_NAMES.has(normalized) ||
    /(?:access|auth|bearer|refresh|session|id)token$/u.test(normalized) ||
    /(?:api|private|signing|encryption|secret|client)key$/u.test(normalized) ||
    /(?:password|secret|credential)$/u.test(normalized)
  );
}

/** Keep credential labels and inline credentials out of plain metadata. */
export function redactCredentialFields(
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        isSecretName(key) || redactLogText(value) !== value ? REDACTED : value,
      ]),
    ),
  );
}

function sanitizeError(
  error: Error,
  depth: number,
  state: SanitizeState,
): Error {
  try {
    if (state.seen.has(error)) {
      return new Error('[Circular error]');
    }
    state.seen.add(error);

    const cause =
      'cause' in error
        ? sanitizeValue(error.cause, depth + 1, state)
        : undefined;
    const sanitized =
      cause === undefined
        ? new Error(redactLogText(error.message))
        : new Error(redactLogText(error.message), { cause });
    sanitized.name = redactLogText(error.name);
    if (error.stack !== undefined) {
      sanitized.stack = redactLogText(error.stack);
    }
    return sanitized;
  } catch {
    return new Error('[Unserializable error]');
  }
}

interface SanitizeState {
  remainingEntries: number;
  seen: WeakSet<object>;
}

function sanitizeArray(
  value: readonly unknown[],
  depth: number,
  state: SanitizeState,
): readonly unknown[] | string {
  try {
    const length = Math.min(value.length, MAX_SANITIZE_ENTRIES);
    const sanitized: unknown[] = [];
    for (
      let index = 0;
      index < length && state.remainingEntries > 0;
      index += 1
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined) {
        sanitized.length += 1;
        continue;
      }
      state.remainingEntries -= 1;
      sanitized.push(
        'value' in descriptor
          ? sanitizeValue(descriptor.value, depth + 1, state)
          : '[Accessor]',
      );
    }
    return sanitized;
  } catch {
    return '[Unserializable]';
  }
}

function sanitizeValue(
  value: unknown,
  depth: number,
  state: SanitizeState,
): unknown {
  try {
    if (typeof value === 'string') return redactLogText(value);
    if (typeof value !== 'object' || value === null) return value;
    if (depth >= MAX_SANITIZE_DEPTH || state.remainingEntries <= 0)
      return TRUNCATED;
    if (value instanceof Error) return sanitizeError(value, depth, state);
    if (state.seen.has(value)) return '[Circular]';
    state.seen.add(value);
    return Array.isArray(value)
      ? sanitizeArray(value, depth, state)
      : sanitizeRecord(value, depth, state);
  } catch {
    return '[Unserializable]';
  }
}

function sanitizeRecord(
  value: object,
  depth: number,
  state: SanitizeState,
  excludedNames: ReadonlySet<string> = new Set(),
): Record<string, unknown> | string {
  try {
    const sanitized: Record<string, unknown> = {};
    let admitted = 0;
    for (const key of Reflect.ownKeys(value)) {
      const omitField =
        typeof key !== 'string' ||
        excludedNames.has(key) ||
        admitted >= MAX_SANITIZE_ENTRIES ||
        state.remainingEntries <= 0;
      if (omitField) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      admitted += 1;
      state.remainingEntries -= 1;
      if (isSecretName(key)) {
        sanitized[key] = REDACTED;
      } else if ('value' in descriptor) {
        sanitized[key] = sanitizeValue(descriptor.value, depth + 1, state);
      } else {
        sanitized[key] = '[Accessor]';
      }
    }
    return sanitized;
  } catch {
    return '[Unserializable]';
  }
}

export function safeFields(
  fields: LogFields | undefined,
): Record<string, unknown> {
  if (fields === undefined) {
    return {};
  }

  try {
    const state: SanitizeState = {
      remainingEntries: MAX_SANITIZE_TOTAL_ENTRIES,
      seen: new WeakSet(),
    };
    state.seen.add(fields);
    const sanitized = sanitizeRecord(fields, 0, state, RESERVED_FIELDS);
    return typeof sanitized === 'string' ? {} : sanitized;
  } catch {
    return {};
  }
}

export function errorValue(error: unknown): Error | undefined {
  if (error === undefined) {
    return undefined;
  }

  const state: SanitizeState = {
    remainingEntries: MAX_SANITIZE_TOTAL_ENTRIES,
    seen: new WeakSet(),
  };
  try {
    if (error instanceof Error) return sanitizeError(error, 0, state);
    return new Error('Non-Error value thrown', {
      cause: sanitizeValue(error, 0, state),
    });
  } catch {
    return new Error('[Unserializable error]');
  }
}
