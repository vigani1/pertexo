export const variableProblems = {
  'variables.changed': {
    status: 409,
    title: 'Workspace variables changed',
    severity: 'info',
    exposeDetail: true,
  },
  'variables.usage_changed': {
    status: 409,
    title: 'Workflow references changed',
    severity: 'info',
    exposeDetail: true,
  },
  'workflow.variable_snapshot_unavailable': {
    status: 409,
    title: 'Captured workspace variables unavailable',
    severity: 'info',
    exposeDetail: true,
  },
} as const;
