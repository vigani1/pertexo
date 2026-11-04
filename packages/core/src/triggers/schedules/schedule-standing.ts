import {
  triggerSchedules,
  workflowTriggers,
  workflows,
  workspaces,
} from '@pertexo/database/schema';

export const scheduleStandingColumns = {
  scheduleStatus: triggerSchedules.status,
  triggerStatus: workflowTriggers.status,
  workflowStatus: workflows.lifecycleStatus,
  activationStatus: workflows.activationStatus,
  publishedVersionId: workflows.publishedVersionId,
  triggerVersionId: workflowTriggers.workflowVersionId,
  workspaceStatus: workspaces.status,
};

/** Admission rechecks the same standing that upcoming-fire reads present. */
export function scheduleCanFire(
  standing: Readonly<{
    scheduleStatus: string;
    triggerStatus: string;
    workflowStatus: string;
    activationStatus: string;
    publishedVersionId: string | null;
    triggerVersionId: string;
    workspaceStatus: string;
  }>,
): boolean {
  return (
    standing.scheduleStatus === 'enabled' &&
    standing.triggerStatus === 'active' &&
    standing.workflowStatus === 'active' &&
    ['active', 'degraded'].includes(standing.activationStatus) &&
    standing.publishedVersionId === standing.triggerVersionId &&
    standing.workspaceStatus === 'active'
  );
}
