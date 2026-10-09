import type { WorkflowAutoPauseSettings } from '@pertexo/contracts';

export const unpausedWorkflowSettings: WorkflowAutoPauseSettings = {
  enabled: true,
  thresholdOverride: null,
  workspaceThreshold: 10,
  effectiveThreshold: 10,
  settingsRevision: 1,
  pauseState: 'none',
  pauseRevision: '1',
  pausedAt: null,
  pauseReason: null,
  pausedFailures: null,
  pausedLastRunId: null,
};
