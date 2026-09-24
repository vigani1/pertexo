import { canonicalizeJson } from '@/lib/canonical-json';

/** What a new run starts with: its input and an optional deadline. */
export type RunIntent = Readonly<{ value: unknown; deadlineAt?: string }>;

export type RunInputField = 'input' | 'deadline';

export function runInputProblem(text: string): string | undefined {
  try {
    JSON.parse(text);
    return undefined;
  } catch {
    return 'The input isn’t valid JSON. Check for a missing quote, comma or brace.';
  }
}

export function runDeadlineProblem(text: string): string | undefined {
  return text.trim() === '' || !Number.isNaN(new Date(text).getTime())
    ? undefined
    : 'Enter the deadline as a date and time.';
}

/** The intent for input and deadline text that have no problems. */
export function toRunIntent(input: string, deadline: string): RunIntent {
  const trimmed = deadline.trim();
  return {
    value: JSON.parse(input) as unknown,
    ...(trimmed === '' ? {} : { deadlineAt: new Date(trimmed).toISOString() }),
  };
}

/** One text per intent, so an exact retry can tell whether anything changed. */
export function normalizeRunIntent(intent: RunIntent): string {
  return canonicalizeJson({
    deadlineAt: intent.deadlineAt ?? null,
    value: intent.value,
  });
}
