export const workflowsLifecycleProblems = {
  'workflow.revision_conflict': {
    status: 412,
    title: 'Workflow revision conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.lifecycle_conflict': {
    status: 409,
    title: 'Workflow lifecycle conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.name_conflict': {
    status: 409,
    title: 'Workflow name conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.pause_conflict': {
    status: 409,
    title: 'Workflow pause conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.auto_pause_settings_conflict': {
    status: 409,
    title: 'Workflow auto-pause settings conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.invalid': {
    status: 422,
    title: 'Invalid workflow',
    severity: 'info',
    exposeDetail: true,
  },
  'workflow.validation_unavailable': {
    status: 503,
    title: 'Workflow validation unavailable',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.not_published': {
    status: 409,
    title: 'Workflow not published',
    severity: 'info',
    exposeDetail: true,
  },
  'workflow.activation_failed': {
    status: 409,
    title: 'Workflow activation failed',
    severity: 'warn',
    exposeDetail: true,
  },
} as const;
