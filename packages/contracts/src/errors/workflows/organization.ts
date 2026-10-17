export const WORKFLOW_ORGANIZATION_PROBLEM_CODES = [
  'workflow.tag_key_conflict',
  'workflow.tag_limit_exceeded',
  'workflow.tag_revision_conflict',
  'workflow.tag_delete_overflow',
  'workflow.organization_revision_conflict',
  'workflow.folder_name_conflict',
  'workflow.folder_limit_exceeded',
  'workflow.folder_revision_conflict',
  'workflow.folder_hierarchy_conflict',
  'workflow.folder_not_empty',
  'workflow.folder_not_visible',
] as const;

export const workflowOrganizationProblems = {
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
  'workflow.folder_name_conflict': {
    status: 409,
    title: 'Workflow folder name conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.folder_limit_exceeded': {
    status: 409,
    title: 'Workflow folder limit exceeded',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.folder_revision_conflict': {
    status: 409,
    title: 'Workflow folder revision conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.folder_hierarchy_conflict': {
    status: 409,
    title: 'Workflow folder hierarchy conflict',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.folder_not_empty': {
    status: 409,
    title: 'Workflow folder is not empty',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.folder_not_visible': {
    status: 409,
    title: 'Workflow folder is not visible',
    severity: 'warn',
    exposeDetail: true,
  },
} as const;
