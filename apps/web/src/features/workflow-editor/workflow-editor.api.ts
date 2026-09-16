import {
  strongEtagSchema,
  workflowDraftSaveRequestSchema,
  workflowRevisionConflictProblemSchema,
  type WorkflowGraphContract,
} from '@pertexo/contracts/schemas/workflow-authoring';
import type { ApiClient } from '@/lib/api/client';
import {
  decodeWorkflowDraftSnapshot,
  type WorkflowDraftSnapshot,
} from '@/features/workflow-drafts/public';

export type { WorkflowDraftSnapshot } from '@/features/workflow-drafts/public';

function workflowDraftPath(workspaceId: string, workflowId: string) {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/draft` as const;
}

export function getWorkflowDraft(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
): Promise<WorkflowDraftSnapshot> {
  return apiClient.request({
    path: workflowDraftPath(workspaceId, workflowId),
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value, metadata) =>
        decodeWorkflowDraftSnapshot(value, metadata.header('etag')),
    },
  });
}

export function saveWorkflowDraft(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  input: Readonly<{
    graph: WorkflowGraphContract;
    etag: string;
    signal?: AbortSignal;
  }>,
): Promise<WorkflowDraftSnapshot> {
  return apiClient.request({
    path: workflowDraftPath(workspaceId, workflowId),
    method: 'PUT',
    body: workflowDraftSaveRequestSchema.parse({ graph: input.graph }),
    headers: { 'If-Match': strongEtagSchema.parse(input.etag) },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    decodeProblem: (value) =>
      workflowRevisionConflictProblemSchema.parse(value),
    response: {
      kind: 'json',
      decode: (value, metadata) =>
        decodeWorkflowDraftSnapshot(value, metadata.header('etag')),
    },
  });
}
