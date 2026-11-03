import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { workflowRuns } from '@pertexo/database/schema';
export const workflowRunSelection = {
  id: workflowRuns.id,
  workspaceId: workflowRuns.workspaceId,
  workflowId: workflowRuns.workflowId,
  workflowVersionId: workflowRuns.workflowVersionId,
  status: workflowRuns.status,
  triggerType: workflowRuns.triggerType,
  createdAt: workflowRuns.createdAt,
  updatedAt: workflowRuns.updatedAt,
  startedAt: workflowRuns.startedAt,
  completedAt: workflowRuns.completedAt,
  deadlineAt: workflowRuns.deadlineAt,
  cancelRequestedAt: workflowRuns.cancelRequestedAt,
};
export function workflowRunRecords(db: Pick<NodePgDatabase, 'select'>) {
  return db.select(workflowRunSelection).from(workflowRuns);
}
export type WorkflowRunRow = Awaited<
  ReturnType<typeof workflowRunRecords>
>[number];
