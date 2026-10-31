import { redactLogText } from './logging/redaction.js';

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
  if (typeof value !== 'object' || value === null || !('issues' in value))
    return undefined;
  const { issues } = value;
  return Array.isArray(issues) ? (issues as SettingsIssue[]) : undefined;
}

const MAX_CAUSE_DEPTH = 8;
const MAX_CAUSE_LENGTH = 2_000;

function causeChain(error: unknown, depth: number): readonly string[] {
  if (depth >= MAX_CAUSE_DEPTH) return [];
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
  return [redactLogText(error.message), ...causeChain(error.cause, depth + 1)];
}

/**
 * Why a process could not run, in words safe for a log: the operator needs this
 * while the application is down, and it may be the only line they ever get.
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
