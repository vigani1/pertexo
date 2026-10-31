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

/**
 * A run job that can never be delivered as written, so it is rebuilt from the
 * run. Only a run still underway needs it, and a running attempt's lease is its
 * clock.
 */
export function overdueDeliveryAction(
  delivery: Readonly<{
    runStatus: string | undefined;
    attemptStatus: string | undefined;
    jobName: string;
  }>,
): 'replace' | 'drop' {
  if (
    delivery.runStatus !== 'queued' &&
    delivery.runStatus !== 'running' &&
    delivery.runStatus !== 'waiting'
  )
    return 'drop';
  return delivery.jobName !== 'execute-node-attempt' ||
    delivery.attemptStatus === 'ready'
    ? 'replace'
    : 'drop';
}

export function evidenceOutcome(status: string | undefined): string {
  if (status === undefined) return 'not_found';
  if (status !== 'outcome_unknown') return 'not_unknown';
  return 'evidence_recorded';
}

export function resumeOutcome(
  status: string,
  input: Readonly<{ dueNodeCount: number; dueWait: boolean; dryRun: boolean }>,
): string {
  if (TERMINAL_RUN_STATUSES.has(status)) return 'terminal';
  if (input.dueNodeCount === 0 && !input.dueWait) return 'not_due';
  return input.dryRun ? 'would_resume' : 'resumed';
}

export function cancellationOutcome(
  run: Readonly<{ status: string; cancelRequested: boolean }> | undefined,
  input: Readonly<{ dryRun: boolean }>,
): string {
  if (run === undefined) return 'not_found';
  if (TERMINAL_RUN_STATUSES.has(run.status)) return 'terminal';
  if (run.cancelRequested) return 'already_requested';
  return input.dryRun ? 'would_cancel' : 'cancel_requested';
}

const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);

export function triggerReconciliationOutcome(
  workflow: Readonly<{ publishedVersionId: string | null }> | undefined,
  publishedVersionId: string | null,
  input: Readonly<{ dryRun: boolean }>,
): string {
  if (workflow === undefined) return 'not_found';
  if (publishedVersionId === null) return 'not_published';
  return input.dryRun ? 'would_retry' : 'retry_requested';
}

export function runReplayOutcome(
  source:
    | Readonly<{
        sourceWorkflowId: string;
        targetWorkflowId: string | null;
      }>
    | undefined,
  input: Readonly<{ dryRun: boolean }>,
): string {
  if (source === undefined) return 'source_not_found';
  if (source.targetWorkflowId === null) return 'version_not_executable';
  if (source.targetWorkflowId !== source.sourceWorkflowId)
    return 'workflow_mismatch';
  return input.dryRun ? 'would_request' : 'replay_requested';
}

export function redispatchOutcome(
  outbox:
    Readonly<{ publishedAt: Date | null; failedAt: Date | null }> | undefined,
  input: Readonly<{ dryRun: boolean }>,
): string {
  if (outbox === undefined) return 'not_found';
  if (outbox.publishedAt !== null) return 'already_published';
  if (outbox.failedAt === null) return 'not_failed';
  return input.dryRun ? 'would_redispatch' : 'redispatched';
}
