export const workflowErrorProblems = {
  'workflow.error_policy_conflict': {
    status: 409,
    title: 'Error workflow settings changed',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.error_target_unavailable': {
    status: 409,
    title: 'Error workflow unavailable',
    severity: 'warn',
    exposeDetail: true,
  },
} as const;
