export const pendingTaskProblems = {
  'pending_task.already_resolved': {
    status: 409,
    title: 'Task already resolved',
    severity: 'info',
    exposeDetail: true,
  },
  'pending_task.expired': {
    status: 409,
    title: 'Task expired',
    severity: 'info',
    exposeDetail: true,
  },
  'pending_task.run_closed': {
    status: 409,
    title: 'Run is no longer waiting',
    severity: 'info',
    exposeDetail: true,
  },
  'pending_task.self_decision': {
    status: 403,
    title: 'Another person must decide',
    severity: 'info',
    exposeDetail: true,
  },
  'pending_task.not_eligible': {
    status: 403,
    title: 'You cannot decide this task',
    severity: 'info',
    exposeDetail: true,
  },
} as const;
