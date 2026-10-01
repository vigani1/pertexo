import type { WorkflowConcurrencySettings } from '@pertexo/contracts/schemas/workflow-authoring';

export const defaultConcurrencySettings: WorkflowConcurrencySettings = {
  asOf: '2026-10-01T10:00:00.000000Z',
  limit: null,
  revision: 1,
  workspaceActiveRunLimit: 10,
  workspacePolicyState: 'active',
  overflow: 'queue',
};
