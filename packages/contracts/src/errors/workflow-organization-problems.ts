export const WORKFLOW_ORGANIZATION_PROBLEM_CODES = [
  'workflow.organization_unavailable',
  'workflow.tag_key_conflict',
  'workflow.tag_limit_exceeded',
  'workflow.tag_revision_conflict',
  'workflow.tag_delete_overflow',
  'workflow.organization_revision_conflict',
  'workflow.favorite_revision_conflict',
] as const;

export const workflowOrganizationProblems = {
  'workflow.organization_unavailable': {
    status: 503,
    title: 'Workflow organization unavailable',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.tag_key_conflict': {
    status: 409,
    title: 'Workflow tag key conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.tag_limit_exceeded': {
    status: 409,
    title: 'Workflow tag limit exceeded',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.tag_revision_conflict': {
    status: 409,
    title: 'Workflow tag revision conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.tag_delete_overflow': {
    status: 409,
    title: 'Workflow tag deletion requires bounded cleanup',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.organization_revision_conflict': {
    status: 409,
    title: 'Workflow organization revision conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.favorite_revision_conflict': {
    status: 409,
    title: 'Workflow favorite revision conflict',
    severity: 'warn',
    exposeDetail: true,
  },
} as const;
