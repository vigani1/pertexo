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
} as const;

export const checkedStartProblems = {
  'workflow.published_version_conflict': {
    status: 409,
    title: 'Published workflow version changed',
    severity: 'info',
    exposeDetail: true,
  },
} as const;
