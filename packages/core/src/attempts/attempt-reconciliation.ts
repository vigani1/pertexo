export function attemptReconciliationOutcome(
  attempt:
    | Readonly<{
        status: string;
        fenceToken: number;
        leaseExpired: boolean | null;
        dispatchMarkedAt: Date | null;
        sideEffectClass: string;
      }>
    | undefined,
  input: Readonly<{
    expectedFenceToken: number;
    action: 'reclaim' | 'outcome_unknown';
    dryRun: boolean;
  }>,
): string {
  if (attempt === undefined) return 'not_found';
  if (attempt.status !== 'running') return 'not_running';
  if (attempt.fenceToken !== input.expectedFenceToken) return 'fence_conflict';
  if (!(attempt.leaseExpired ?? false)) return 'lease_active';
  const unsafeReclaim =
    input.action === 'reclaim' &&
    attempt.dispatchMarkedAt !== null &&
    attempt.sideEffectClass === 'unsafe';
  if (unsafeReclaim) return 'reclaim_unsafe';
  if (input.dryRun)
    return input.action === 'reclaim' ? 'would_reclaim' : 'would_mark_unknown';
  return input.action === 'reclaim' ? 'reclaimed' : 'marked_unknown';
}

/**
 * What automatic recovery asks of an expired lease: a repeat is only ever
 * requested when it cannot duplicate an effect.
 */
export function automaticReconciliationAction(
  attempt: Readonly<{
    dispatchMarkedAt: Date | null;
    sideEffectClass: string;
  }>,
): 'reclaim' | 'outcome_unknown' {
  return attempt.dispatchMarkedAt !== null &&
    attempt.sideEffectClass === 'unsafe'
    ? 'outcome_unknown'
    : 'reclaim';
}
