import type {
  PendingTaskSummary,
  PendingTaskListQuery,
} from '@pertexo/contracts';
export function parseApprovalSearch(
  value: Record<string, unknown>,
): Pick<PendingTaskListQuery, 'view' | 'status'> {
  return {
    view: value.view === 'all' ? 'all' : 'mine',
    status:
      value.status === 'resolved' || value.status === 'all'
        ? value.status
        : 'pending',
  };
}
export function taskTone(status: PendingTaskSummary['status']) {
  switch (status) {
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
export function blockedSentence(reason: PendingTaskSummary['blockedReason']) {
  switch (reason) {
    case 'starter':
      return 'The person who started this run cannot decide. Another eligible member needs to respond.';
    case 'audience':
      return 'Your current role or member identity is not in this approval’s audience.';
    case 'expired':
      return 'This approval expired. The step follows its failure path.';
    case 'run_closed':
      return 'This run was canceled, finished, or reached its deadline. It cannot accept a decision.';
    case 'resolved':
      return 'This task already has a final result.';
    case null:
      return null;
  }
}
