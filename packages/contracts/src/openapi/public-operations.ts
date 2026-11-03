import type { ApiProblemCode } from '../errors/api-problem.js';

type PublicOperation = Readonly<{
  summary: string;
  tag:
    | 'Tokens'
    | 'Workflows'
    | 'Connections'
    | 'Runs'
    | 'Triggers'
    | 'Data tables'
    | 'Variables';
  scopes: readonly string[];
  /** Beyond what every token route can answer. */
  problems?: readonly ApiProblemCode[];
}>;

/** A route that takes a token is public: it's documented here, or the build fails. */
export const PUBLIC_OPERATIONS: Readonly<Record<string, PublicOperation>> = {
  readCurrentApiToken: {
    summary: 'Read the calling token',
    tag: 'Tokens',
    scopes: [],
  },
  listWorkflows: {
    summary: 'List workflows',
    tag: 'Workflows',
    scopes: ['workflow:read'],
  },
  getWorkflow: {
    summary: 'Read a workflow',
    tag: 'Workflows',
    scopes: ['workflow:read'],
  },
  createWorkflow: {
    summary: 'Create a blank workflow',
    tag: 'Workflows',
    scopes: ['workflow:create'],
    problems: ['request.idempotency_conflict', 'workflow.name_conflict'],
  },
  saveWorkflowDraft: {
    summary: 'Save a workflow draft',
    tag: 'Workflows',
    scopes: ['workflow:update'],
    problems: [
      'request.precondition_required',
      'workflow.revision_conflict',
      'workflow.invalid',
    ],
  },
  getWorkflowDraft: {
    summary: 'Read a workflow draft',
    tag: 'Workflows',
    scopes: ['workflow:read'],
  },
  listWorkflowVersions: {
    summary: 'List published versions',
    tag: 'Workflows',
    scopes: ['workflow:read'],
  },
  publishWorkflow: {
    summary: 'Publish a draft',
    tag: 'Workflows',
    scopes: ['workflow:publish'],
    problems: [
      'request.precondition_required',
      'request.idempotency_conflict',
      'workflow.revision_conflict',
      'workflow.invalid',
      'workflow.publish_approval_required',
      'workflow.validation_unavailable',
    ],
  },
  exportWorkflow: {
    summary: 'Export a workflow',
    tag: 'Workflows',
    scopes: ['workflow:read'],
    problems: [
      'request.precondition_required',
      'workflow.revision_conflict',
      'workflow.portability_review_conflict',
      'workflow.portability_unavailable',
    ],
  },
  previewWorkflowImport: {
    summary: 'Preview an import',
    tag: 'Workflows',
    scopes: ['workflow:create', 'connection:read'],
    problems: [
      'workflow.portability_invalid',
      'workflow.portability_compatibility_conflict',
      'workflow.portability_unavailable',
    ],
  },
  importWorkflow: {
    summary: 'Import a workflow',
    tag: 'Workflows',
    scopes: ['workflow:create', 'connection:read'],
    problems: [
      'request.idempotency_conflict',
      'workflow.portability_invalid',
      'workflow.portability_review_conflict',
      'workflow.portability_compatibility_conflict',
      'workflow.portability_unavailable',
    ],
  },
  archiveWorkflow: {
    summary: 'Archive a workflow',
    tag: 'Workflows',
    scopes: ['workflow:publish'],
    problems: ['request.idempotency_conflict', 'workflow.lifecycle_conflict'],
  },
  restoreWorkflow: {
    summary: 'Restore an archived workflow',
    tag: 'Workflows',
    scopes: ['workflow:publish'],
    problems: ['request.idempotency_conflict', 'workflow.lifecycle_conflict'],
  },
  getWorkflowAutoPauseSettings: {
    summary: 'Read automatic-pause settings',
    tag: 'Workflows',
    scopes: ['workflow:read'],
  },
  updateWorkflowAutoPauseSettings: {
    summary: 'Update automatic-pause settings',
    tag: 'Workflows',
    scopes: ['workflow:update'],
    problems: [
      'request.idempotency_conflict',
      'workflow.auto_pause_settings_conflict',
    ],
  },
  resumeWorkflow: {
    summary: 'Resume automatic triggers',
    tag: 'Workflows',
    scopes: ['workflow:publish'],
    problems: ['request.idempotency_conflict', 'workflow.pause_conflict'],
  },
  listWebhookTriggers: {
    summary: 'List webhook triggers',
    tag: 'Triggers',
    scopes: ['workflow:read'],
  },
  listWebhookDeliveries: {
    summary: 'List webhook deliveries',
    tag: 'Triggers',
    scopes: ['workflow:read'],
  },
  provisionWebhookEndpoint: {
    summary: 'Provision a webhook endpoint',
    tag: 'Triggers',
    scopes: ['workflow:update'],
    problems: [
      'request.idempotency_conflict',
      'workspace.conflict',
      'webhook.setting_up',
    ],
  },
  listScheduleTriggers: {
    summary: 'List schedule triggers',
    tag: 'Triggers',
    scopes: ['workflow:read'],
  },
  listScheduleOccurrences: {
    summary: 'List schedule occurrences',
    tag: 'Triggers',
    scopes: ['workflow:read'],
  },
  listScheduleNextRuns: {
    summary: 'List upcoming schedule fire times',
    tag: 'Triggers',
    scopes: ['workflow:read'],
  },
  previewScheduleRuns: {
    summary: 'Preview a schedule rule',
    tag: 'Triggers',
    scopes: ['workflow:read'],
  },
  enableScheduleTrigger: {
    summary: 'Enable a schedule trigger',
    tag: 'Triggers',
    scopes: ['workflow:update'],
    problems: ['request.idempotency_conflict'],
  },
  disableScheduleTrigger: {
    summary: 'Disable a schedule trigger',
    tag: 'Triggers',
    scopes: ['workflow:update'],
    problems: ['request.idempotency_conflict'],
  },
  listDataTables: {
    summary: 'List workspace tables',
    tag: 'Data tables',
    scopes: ['workspace:read'],
  },
  createDataTable: {
    summary: 'Create a table',
    tag: 'Data tables',
    scopes: ['workflow:update'],
    problems: [
      'request.idempotency_conflict',
      'data_table.conflict',
      'data_table.key_conflict',
      'data_table.quota_exceeded',
    ],
  },
  removeDataTable: {
    summary: 'Remove a table',
    tag: 'Data tables',
    scopes: ['workflow:update'],
    problems: ['request.idempotency_conflict', 'data_table.conflict'],
  },
  editDataTableSchema: {
    summary: 'Change table columns',
    tag: 'Data tables',
    scopes: ['workflow:update'],
    problems: [
      'request.idempotency_conflict',
      'data_table.conflict',
      'data_table.quota_exceeded',
    ],
  },
  findDataTableRows: {
    summary: 'Query table rows',
    tag: 'Data tables',
    scopes: ['workspace:read'],
  },
  writeDataTableRows: {
    summary: 'Write table rows',
    tag: 'Data tables',
    scopes: ['workflow:update'],
    problems: [
      'request.idempotency_conflict',
      'data_table.conflict',
      'data_table.key_conflict',
      'data_table.quota_exceeded',
    ],
  },
  importDataTableCsv: {
    summary: 'Import table rows from CSV',
    tag: 'Data tables',
    scopes: ['workflow:update'],
    problems: [
      'request.idempotency_conflict',
      'data_table.conflict',
      'data_table.key_conflict',
      'data_table.quota_exceeded',
    ],
  },
  getWorkspaceVariables: {
    summary: 'Read non-secret workspace variables',
    tag: 'Variables',
    scopes: ['workspace:read'],
  },
  replaceWorkspaceVariables: {
    summary: 'Replace workspace variables',
    tag: 'Variables',
    scopes: ['variable:manage'],
    problems: ['request.idempotency_conflict', 'variables.changed'],
  },
  listWorkspaceVariableReferences: {
    summary: 'Find variable references',
    tag: 'Variables',
    scopes: ['workspace:read', 'workflow:read'],
    problems: ['variables.usage_changed'],
  },
  listWorkflowTags: {
    summary: 'List shared workflow tags',
    tag: 'Workflows',
    scopes: ['workflow:read'],
  },
  listWorkflowTagAssignments: {
    summary: 'List workflows assigned to a tag',
    tag: 'Workflows',
    scopes: ['workflow:read'],
  },
  replaceWorkflowTags: {
    summary: 'Replace a workflow’s tags',
    tag: 'Workflows',
    scopes: ['workflow:update'],
    problems: [
      'request.idempotency_conflict',
      'workflow.organization_revision_conflict',
    ],
  },
  listConnections: {
    summary: 'List connections',
    tag: 'Connections',
    scopes: ['connection:read'],
  },
  getConnection: {
    summary: 'Read a connection',
    tag: 'Connections',
    scopes: ['connection:read'],
  },
  startWorkflowRun: {
    summary: 'Start a run',
    tag: 'Runs',
    scopes: ['run:start'],
    problems: [
      'request.idempotency_conflict',
      'workflow.not_published',
      'workflow.already_running',
      'workflow.published_version_conflict',
      'workspace.quota_exceeded',
      'workspace.conflict',
      'form.required',
    ],
  },
  listWorkflowRuns: { summary: 'List runs', tag: 'Runs', scopes: ['run:read'] },
  getWorkflowRun: { summary: 'Read a run', tag: 'Runs', scopes: ['run:read'] },
  getWorkflowRunInput: {
    summary: 'Read a run’s input',
    tag: 'Runs',
    scopes: ['run:read-data'],
  },
  getWorkflowNodeRunInput: {
    summary: 'Read a step’s input',
    tag: 'Runs',
    scopes: ['run:read-data'],
  },
  getWorkflowNodeRunOutput: {
    summary: 'Read a step’s output',
    tag: 'Runs',
    scopes: ['run:read-data'],
  },
  cancelWorkflowRun: {
    summary: 'Cancel a run',
    tag: 'Runs',
    scopes: ['run:cancel'],
    problems: ['run.not_cancelable'],
  },
};

export const EVERY_TOKEN_ROUTE: readonly ApiProblemCode[] = [
  'request.invalid',
  'auth.unauthenticated',
  'auth.token_scope_required',
  'auth.forbidden',
  'resource.not_found',
  'request.rate_limited',
  'request.rate_limit_unavailable',
  'api_token.unavailable',
];
