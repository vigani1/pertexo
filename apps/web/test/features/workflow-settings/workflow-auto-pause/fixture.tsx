import type { WorkflowAutoPauseSettings } from '@pertexo/contracts';
import { unpausedWorkflowSettings } from '../../../support/fixtures/auto-pause';
import { workflowId, workspaceId } from '../fixtures';
export const path = `/w/${workspaceId}/workflows/${workflowId}/settings`;

export const paused: WorkflowAutoPauseSettings = {
  ...unpausedWorkflowSettings,
  pauseState: 'paused',
  pauseRevision: '9007199254740993',
  pausedAt: '2026-09-30T10:00:00Z',
  pauseReason: 'consecutive_failures',
  pausedFailures: 10,
  pausedLastRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

export function sentence(start: string) {
  return (_: string, element: Element | null) =>
    element?.tagName === 'P' &&
    element.textContent.replace(/\s+/gu, ' ').startsWith(start);
}
