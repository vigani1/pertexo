import {
  StartupSettingError,
  describeStartupSettingError,
} from './startup-setting.errors.js';
import { z } from 'zod';
import { describeInheritedSessionContext } from './inherited-session-context.errors.js';

const SYSTEM_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'EACCES',
  'EPERM',
  'ENOENT',
  'ENOSPC',
  'EMFILE',
  'ENFILE',
  'ENOMEM',
]);

/** A closed machine vocabulary keeps useful failures without trusting error text. */
export function safeSystemErrorCode(value: unknown): string | undefined {
  try {
    if (typeof value !== 'object' || value === null) return undefined;
    const code: unknown = (value as { code?: unknown }).code;
    return typeof code === 'string' && SYSTEM_ERROR_CODES.has(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

export type ProcessErrorType = 'Error' | 'NonError';

export function classifyProcessError(value: unknown): ProcessErrorType {
  try {
    return value instanceof Error ? 'Error' : 'NonError';
  } catch {
    return 'NonError';
  }
}

type SettingsIssue = Readonly<{ code: string; path: readonly PropertyKey[] }>;

function settingsIssues(value: unknown): readonly SettingsIssue[] | undefined {
  return value instanceof z.ZodError ? value.issues : undefined;
}

const MAX_CAUSE_DEPTH = 8;
const MAX_CAUSE_LENGTH = 2_000;

function causeChain(error: unknown, depth: number): readonly string[] {
  if (depth >= MAX_CAUSE_DEPTH) return [];
  if (error instanceof StartupSettingError)
    return [describeStartupSettingError(error)];
  const inherited = describeInheritedSessionContext(error);
  if (inherited !== undefined) return [inherited];
  const issues = settingsIssues(error);
  // Settings are named with what is wrong; a schema's message can quote the
  // rejected value, which may be a secret, so it never reaches a log.
  if (issues !== undefined)
    return [
      `invalid settings: ${issues
        .map(({ code, path }) => `${path.map(String).join('.')} (${code})`)
        .join(', ')}`,
    ];
  if (error instanceof AggregateError)
    return (error.errors as unknown[]).flatMap((entry) =>
      causeChain(entry, depth + 1),
    );
  if (!(error instanceof Error)) return [];
  return [
    safeSystemErrorCode(error) ?? '[Redacted]',
    ...causeChain(error.cause, depth + 1),
  ];
}

/**
 * Keep typed setting issues and the database's inherited-settings refusal
 * for startup repair; generic error text is private.
 */
export function describeProcessFailure(value: unknown): string {
  try {
    const chain = causeChain(value, 0).filter((part) => part.length > 0);
    const cause = chain.join(': ');
    return cause.length > 0
      ? cause.slice(0, MAX_CAUSE_LENGTH)
      : 'no reason given';
  } catch {
    return 'no reason given';
  }
}
