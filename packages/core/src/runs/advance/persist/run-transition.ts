import { decodeStoredValue } from '../../../shared/stored-values.js';
import {
  isTerminalRunEvent,
  isUnsuccessfulRunEvent,
  TERMINAL_RUN_STATUSES,
} from '../../statuses.js';
import { WORKSPACE_INBOX_FAILURE_KINDS } from '../../statuses.js';
import { parseStoredExecutionValue } from '../../../shared/stored-execution.js';
import { isTestRun } from '../../../shared/run-retention.repository.js';
import { CoordinatorRunStateCorruptError } from '../coordinator-state.errors.js';
import type { CoordinatorCommitRow } from '../load/load-run.js';
import { canonicalTimestamp } from '../load/fact-admission.js';
import { scheduleRunInputSchema } from '../../../shared/trigger-run-input.schemas.js';
import type { WorkflowTransitionPlan } from '@pertexo/workflow-engine';

/**
 * The engine decides whether its scheduler still has immediate work; a run
 * that ends or starts attempts is woken by those instead.
 */
export function continuesImmediately(plan: WorkflowTransitionPlan): boolean {
  return (
    (plan.immediateContinuation ?? false) &&
    !TERMINAL_RUN_STATUSES.has(plan.checkpoint.runStatus) &&
    plan.attempts.length === 0
  );
}

/** When the run started, finished, and the failure that ended it, from its events. */
export function transitionMoments(plan: WorkflowTransitionPlan) {
  return {
    startedAt: plan.events.find(({ name }) => name === 'run.started')
      ?.occurredAt,
    completedAt: plan.events.find(({ name }) => isTerminalRunEvent(name))
      ?.occurredAt,
    runFailure: plan.events.find(({ name }) => isUnsuccessfulRunEvent(name))
      ?.reasonCode,
  };
}

/** A run with a person in its wait, before or after this transition, keeps its human-wait clock in step. */
export function transitionHasHumanWait(
  row: CoordinatorCommitRow,
  plan: WorkflowTransitionPlan,
): boolean {
  return (
    row.human_wait_started_at !== null ||
    row.has_unconsumed_tasks ||
    (row.has_human_child ?? false) ||
    (plan.taskIntents?.length ?? 0) > 0
  );
}

/** A live run that newly ends unsuccessfully counts toward its day's inbox failures. */
export function recordsInboxFailureDay(
  row: CoordinatorCommitRow,
  plan: WorkflowTransitionPlan,
  completedAt: string | undefined,
): completedAt is string {
  return (
    completedAt !== undefined &&
    !isTestRun(row.trigger_type) &&
    !TERMINAL_RUN_STATUSES.has(row.status) &&
    new Set<string>(WORKSPACE_INBOX_FAILURE_KINDS).has(
      plan.checkpoint.runStatus,
    )
  );
}

/** The occurrence a schedule run was due at, once it starts. */
export function scheduledOccurrence(
  row: CoordinatorCommitRow,
  plan: WorkflowTransitionPlan,
): string | undefined {
  const startedAt = plan.events.find(
    ({ name }) => name === 'run.started',
  )?.occurredAt;
  if (startedAt === undefined || row.trigger_type !== 'schedule')
    return undefined;
  const storedInput = decodeStoredValue(() =>
    parseStoredExecutionValue(row.input_ref),
  );
  if (storedInput.kind !== 'inline')
    throw new CoordinatorRunStateCorruptError();
  const scheduleInput = scheduleRunInputSchema.safeParse(storedInput.value);
  if (!scheduleInput.success) throw new CoordinatorRunStateCorruptError();
  return canonicalTimestamp(scheduleInput.data.scheduledAt);
}
