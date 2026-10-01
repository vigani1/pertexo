export const workflowInputCaseProblems = {
  'workflow.input_case_revision_conflict': {
    status: 412,
    title: 'Run-input case revision conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.input_case_limit_exceeded': {
    status: 409,
    title: 'Run-input case storage limit exceeded',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.input_cases_unavailable': {
    status: 503,
    title: 'Run-input cases unavailable',
    severity: 'warn',
    exposeDetail: true,
  },
} as const;
