export const WORKFLOW_RUN_SOURCES = [
  'test',
  'api',
  'manual',
  'replay',
  'schedule',
  'polling',
  'webhook',
  'workflow_call',
  'workflow_error',
  'form',
] as const;

export type WorkflowRunSource = (typeof WORKFLOW_RUN_SOURCES)[number];
