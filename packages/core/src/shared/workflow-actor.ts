import type { WorkspaceActor } from './workspace-access.js';

export type WorkflowRef = Readonly<{
  workspaceId: string;
  workflowId: string;
}>;
export type WorkflowActor = WorkspaceActor & Readonly<{ workflowId: string }>;
