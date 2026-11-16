export const runsProblems = {
  'run.not_cancelable': {
    status: 409,
    title: 'Run cannot be canceled',
    severity: 'info',
    exposeDetail: true,
  },
  'run.outcome_unknown': {
    status: 409,
    title: 'Run outcome is unknown',
    severity: 'warn',
    exposeDetail: true,
  },
  'run.recovery_unavailable': {
    status: 409,
    title: 'Recovery unavailable',
    severity: 'info',
    exposeDetail: true,
  },
} as const;
