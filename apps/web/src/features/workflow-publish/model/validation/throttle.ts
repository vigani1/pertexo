/** Quiet time after the draft settles before checking it. */
export const AUTO_VALIDATION_QUIET_MS = 1_500;
/**
 * Validate and publish share one per-person limit (30 a minute), so
 * automatic checks never start closer together than this.
 */
export const AUTO_VALIDATION_MIN_INTERVAL_MS = 5_000;

export type AutoValidationInput = Readonly<{
  enabled: boolean;
  saveStatus: string;
  inspectorScratch: boolean;
  pending: boolean;
  revision: number;
  generation: number;
  /** The draft the latest report describes, if any. */
  checked: Readonly<{ revision: number; generation: number }> | undefined;
  /** The saved revision an automatic check last started for. */
  attemptedRevision: number | undefined;
}>;

/**
 * Whether the saved draft still needs an automatic check: at most once per
 * saved revision, only when nothing is unsaved or half-typed.
 */
export function needsAutoValidation(input: AutoValidationInput): boolean {
  if (!input.enabled || input.pending) return false;
  if (input.saveStatus !== 'clean' || input.inspectorScratch) return false;
  if (input.attemptedRevision === input.revision) return false;
  return (
    input.checked?.revision !== input.revision ||
    input.checked.generation !== input.generation
  );
}

/** Milliseconds to wait before the next automatic check may start. */
export function autoValidationDelay(
  input: Readonly<{
    now: number;
    lastStartedAt: number | undefined;
    blockedUntil: number | undefined;
  }>,
): number {
  const earliest = Math.max(
    input.now + AUTO_VALIDATION_QUIET_MS,
    input.lastStartedAt === undefined
      ? 0
      : input.lastStartedAt + AUTO_VALIDATION_MIN_INTERVAL_MS,
    input.blockedUntil ?? 0,
  );
  return earliest - input.now;
}
