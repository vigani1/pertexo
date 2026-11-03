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
  /** Beyond what every token route can answer. */
  problems?: readonly ApiProblemCode[];
}>;

/** A route that takes a token is public: it's documented here, or the build fails. */
export const PUBLIC_OPERATIONS: Readonly<Record<string, PublicOperation>> = {
  readCurrentApiToken: {
    summary: 'Read the calling token',
    tag: 'Tokens',
  },
  listWorkflows: {
    summary: 'List workflows',
    tag: 'Workflows',
  },
  getWorkflow: {
    summary: 'Read a workflow',
    tag: 'Workflows',
  },
  createWorkflow: {
    summary: 'Create a blank workflow',
    tag: 'Workflows',
    problems: ['request.idempotency_conflict', 'workflow.name_conflict'],
  },
  saveWorkflowDraft: {
    summary: 'Save a workflow draft',
    tag: 'Workflows',
    problems: [
      'request.precondition_required',
      'workflow.revision_conflict',
      'workflow.invalid',
    ],
  },
  getWorkflowDraft: {
    summary: 'Read a workflow draft',
    tag: 'Workflows',
  },
  listWorkflowVersions: {
    summary: 'List published versions',
    tag: 'Workflows',
  },
  publishWorkflow: {
    summary: 'Publish a draft',
    tag: 'Workflows',
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
    problems: [
      'workflow.portability_invalid',
      'workflow.portability_compatibility_conflict',
      'workflow.portability_unavailable',
    ],
  },
  importWorkflow: {
    summary: 'Import a workflow',
    tag: 'Workflows',
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
    problems: ['request.idempotency_conflict', 'workflow.lifecycle_conflict'],
  },
  restoreWorkflow: {
    summary: 'Restore an archived workflow',
    tag: 'Workflows',
    problems: ['request.idempotency_conflict', 'workflow.lifecycle_conflict'],
  },
  getWorkflowAutoPauseSettings: {
    summary: 'Read automatic-pause settings',
    tag: 'Workflows',
  },
  updateWorkflowAutoPauseSettings: {
    summary: 'Update automatic-pause settings',
    tag: 'Workflows',
    problems: [
      'request.idempotency_conflict',
      'workflow.auto_pause_settings_conflict',
    ],
  },
  resumeWorkflow: {
    summary: 'Resume automatic triggers',
    tag: 'Workflows',
    problems: ['request.idempotency_conflict', 'workflow.pause_conflict'],
  },
  listWebhookTriggers: {
    summary: 'List webhook triggers',
    tag: 'Triggers',
  },
  listWebhookDeliveries: {
    summary: 'List webhook deliveries',
    tag: 'Triggers',
  },
  provisionWebhookEndpoint: {
    summary: 'Provision a webhook endpoint',
    tag: 'Triggers',
    problems: [
      'request.idempotency_conflict',
      'workspace.conflict',
      'webhook.setting_up',
    ],
  },
  listScheduleTriggers: {
    summary: 'List schedule triggers',
    tag: 'Triggers',
  },
  listScheduleOccurrences: {
    summary: 'List schedule occurrences',
    tag: 'Triggers',
  },
  listScheduleNextRuns: {
    summary: 'List upcoming schedule fire times',
    tag: 'Triggers',
  },
  previewScheduleRuns: {
    summary: 'Preview a schedule rule',
    tag: 'Triggers',
  },
  enableScheduleTrigger: {
    summary: 'Enable a schedule trigger',
    tag: 'Triggers',
    problems: ['request.idempotency_conflict'],
  },
  disableScheduleTrigger: {
    summary: 'Disable a schedule trigger',
    tag: 'Triggers',
    problems: ['request.idempotency_conflict'],
  },
  listDataTables: {
    summary: 'List workspace tables',
    tag: 'Data tables',
  },
  createDataTable: {
    summary: 'Create a table',
    tag: 'Data tables',
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
    problems: ['request.idempotency_conflict', 'data_table.conflict'],
  },
  editDataTableSchema: {
    summary: 'Change table columns',
    tag: 'Data tables',
    problems: [
      'request.idempotency_conflict',
      'data_table.conflict',
      'data_table.quota_exceeded',
    ],
  },
  findDataTableRows: {
    summary: 'Query table rows',
    tag: 'Data tables',
  },
  writeDataTableRows: {
    summary: 'Write table rows',
    tag: 'Data tables',
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
  },
  replaceWorkspaceVariables: {
    summary: 'Replace workspace variables',
    tag: 'Variables',
    problems: ['request.idempotency_conflict', 'variables.changed'],
  },
  listWorkspaceVariableReferences: {
    summary: 'Find variable references',
    tag: 'Variables',
    problems: ['variables.usage_changed'],
  },
  listWorkflowTags: {
    summary: 'List shared workflow tags',
    tag: 'Workflows',
  },
  listWorkflowTagAssignments: {
    summary: 'List workflows assigned to a tag',
    tag: 'Workflows',
  },
  replaceWorkflowTags: {
    summary: 'Replace a workflow’s tags',
    tag: 'Workflows',
    problems: [
      'request.idempotency_conflict',
      'workflow.organization_revision_conflict',
    ],
  },
  listConnections: {
    summary: 'List connections',
    tag: 'Connections',
  },
  getConnection: {
    summary: 'Read a connection',
    tag: 'Connections',
  },
  startWorkflowRun: {
    summary: 'Start a run',
    tag: 'Runs',
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
  listWorkflowRuns: { summary: 'List runs', tag: 'Runs' },
  getWorkflowRun: { summary: 'Read a run', tag: 'Runs' },
  getWorkflowRunInput: {
    summary: 'Read a run’s input',
    tag: 'Runs',
  },
  getWorkflowNodeRunInput: {
    summary: 'Read a step’s input',
    tag: 'Runs',
  },
  getWorkflowNodeRunOutput: {
    summary: 'Read a step’s output',
    tag: 'Runs',
  },
  cancelWorkflowRun: {
    summary: 'Cancel a run',
    tag: 'Runs',
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
