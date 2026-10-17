export const workflowConcurrencyProblems = {
  'workflow.concurrency_revision_conflict': {
    status: 409,
    title: 'Workflow concurrency revision conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.concurrency_limit_exceeded': {
    status: 409,
    title: 'Workflow concurrency limit exceeded',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.concurrency_limit_unavailable': {
    status: 409,
    title: 'Workflow concurrency limit unavailable',
    severity: 'warn',
    exposeDetail: true,
  },
} as const;
