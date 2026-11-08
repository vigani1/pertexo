import type {
  PendingTaskSummary,
  PendingTaskListQuery,
} from '@pertexo/contracts';
import { formatTimeSpan } from '@/lib/format/time';

type TaskWindow = Pick<
  PendingTaskSummary,
  'status' | 'onExpiry' | 'createdAt' | 'expiresAt'
>;

/**
 * "Timed out after 7 days" for a request nobody answered whose step carried
 * on along Timed out; undefined for any other request.
 */
export function timedOutAfter(task: TaskWindow): string | undefined {
  if (task.status !== 'expired' || task.onExpiry !== 'continue')
    return undefined;
  const seconds =
    (Date.parse(task.expiresAt) - Date.parse(task.createdAt)) / 1000;
  return `Timed out after ${formatTimeSpan(seconds)}`;
}
export function parseTaskSearch(
  value: Record<string, unknown>,
  defaultKind: 'all' | 'approval' = 'all',
): Pick<PendingTaskListQuery, 'view' | 'status' | 'kind'> {
  return {
    kind:
      value.kind === 'all' ||
      value.kind === 'approval' ||
      value.kind === 'input_request'
        ? value.kind
        : defaultKind,
    view: value.view === 'all' ? 'all' : 'mine',
    status:
      value.status === 'resolved' || value.status === 'all'
        ? value.status
        : 'pending',
  };
}
export function taskTone(status: PendingTaskSummary['status']) {
  switch (status) {
    case 'submitted':
    case 'approved':
      return 'success';
    case 'rejected':
      return 'attention';
    case 'expired':
      return 'timeout';
    case 'refused':
      return 'failure';
    case 'pending':
      return 'waiting';
    case 'canceled':
      return 'canceled';
  }
}
/** How a request's status reads in a list or a header. */
export function taskStatusLabel(status: PendingTaskSummary['status']) {
  switch (status) {
    case 'pending':
      return 'Waiting';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'submitted':
      return 'Answered';
    case 'expired':
      return 'Expired';
    case 'canceled':
      return 'Canceled';
    case 'refused':
      return 'Refused';
  }
}

/**
 * Who ended a request, for its list row: "Development approved". A request
 * that ended by itself (expired, canceled) reads as its status.
 */
export function taskOutcome(
  task: TaskWindow & Pick<PendingTaskSummary, 'completedByName'>,
) {
  const timedOut = timedOutAfter(task);
  if (timedOut !== undefined) return timedOut;
  const verb = OUTCOME_VERBS[task.status];
  return verb === undefined || task.completedByName === null
    ? taskStatusLabel(task.status)
    : `${task.completedByName} ${verb}`;
}

/** Why a waiting request isn't yours to answer, in a few words for a list. */
export function blockedLabel(reason: PendingTaskSummary['blockedReason']) {
  switch (reason) {
    case 'starter':
      return 'You started this run; someone else decides';
    case 'audience':
      return 'Not in your role’s audience';
    case 'expired':
      return 'Expired';
    case 'run_closed':
      return 'The run has ended';
    case 'workspace_suspended':
      return 'Paused while the workspace is suspended';
    case 'resolved':
    case null:
      return undefined;
  }
}

export function blockedSentence(
  task: Pick<PendingTaskSummary, 'blockedReason' | 'onExpiry'>,
) {
  switch (task.blockedReason) {
    case 'starter':
      return 'The person who started this run cannot decide. Another eligible member needs to respond.';
    case 'audience':
      return 'Your current role or member identity is not in this request’s audience.';
    case 'expired':
      return task.onExpiry === 'continue'
        ? 'Nobody responded in time, so the run continued on its Timed out path.'
        : 'This request expired, so its step failed. A failure route takes over if the workflow has one.';
    case 'run_closed':
      return 'This run was canceled, finished, or reached its deadline. It cannot accept a decision.';
    case 'workspace_suspended':
      return 'This workspace is suspended, so nobody can respond until it is reactivated.';
    case 'resolved':
      return 'This task already has a final result.';
    case null:
      return null;
  }
}

const OUTCOME_VERBS: Readonly<
  Partial<Record<PendingTaskSummary['status'], string>>
> = {
  approved: 'approved',
  rejected: 'rejected',
  submitted: 'answered',
};
