import { isTestRun } from '../../../shared/run-records/run-retention.repository.js';

/** Calls and test runs never count against a workflow's concurrency. */
export function skipsWorkflowConcurrency(triggerType: string): boolean {
  return triggerType === 'workflow_call' || isTestRun(triggerType);
}

/** A skip policy refuses a run once active and queued runs reach its limit. */
export function concurrencyRefusesRun(
  policy:
    Readonly<{ overflow: string; active_run_limit: number | null }> | undefined,
  occupancy: Readonly<{ active_runs: number; queued_runs: number }>,
): boolean {
  return (
    policy?.overflow === 'skip' &&
    policy.active_run_limit !== null &&
    occupancy.active_runs + occupancy.queued_runs >= policy.active_run_limit
  );
}

/** Whether the policy can refuse at all, so occupancy needs reading. */
export function concurrencyMayRefuse(
  policy:
    Readonly<{ overflow: string; active_run_limit: number | null }> | undefined,
): boolean {
  return policy?.overflow === 'skip' && policy.active_run_limit !== null;
}
