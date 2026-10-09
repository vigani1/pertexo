import {
  workflowAutoPauseSettingsSchema,
  workspaceAutoPauseSettingsSchema,
  workflowAutoPauseCommandResponseSchema,
  workspaceAutoPauseCommandResponseSchema,
  workflowAutoPauseSettingsRequestSchema,
  workspaceAutoPauseSettingsRequestSchema,
  workflowResumeRequestSchema,
  workflowPauseConflictProblemSchema,
  workflowAutoPauseSettingsConflictProblemSchema,
  workspaceAutoPauseSettingsConflictProblemSchema,
  type WorkflowAutoPauseSettingsRequest,
  type WorkspaceAutoPauseSettingsRequest,
  type WorkflowResumeRequest,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';

function workspacePath(workspaceId: string): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
}
function workflowPath(workspaceId: string, workflowId: string): `/v1${string}` {
  return `${workspacePath(workspaceId)}/workflows/${encodeURIComponent(workflowId)}`;
}

export function getWorkflowAutoPause(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
) {
  return apiClient.request({
    path: `${workflowPath(workspaceId, workflowId)}/auto-pause`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => workflowAutoPauseSettingsSchema.parse(value),
    },
  });
}

export function getWorkspaceAutoPause(
  apiClient: ApiClient,
  workspaceId: string,
  signal?: AbortSignal,
) {
  return apiClient.request({
    path: `${workspacePath(workspaceId)}/auto-pause`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => workspaceAutoPauseSettingsSchema.parse(value),
    },
  });
}

export type AutoPauseCommand =
  | Readonly<{ kind: 'workflow'; body: WorkflowAutoPauseSettingsRequest }>
  | Readonly<{ kind: 'workspace'; body: WorkspaceAutoPauseSettingsRequest }>
  | Readonly<{ kind: 'resume'; body: WorkflowResumeRequest }>;

export async function commandAutoPause(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  command: AutoPauseCommand,
  key: string,
): Promise<void> {
  if (command.kind === 'workspace') {
    await apiClient.request({
      path: `${workspacePath(workspaceId)}/auto-pause`,
      method: 'PUT',
      headers: { 'Idempotency-Key': key },
      body: workspaceAutoPauseSettingsRequestSchema.parse(command.body),
      decodeProblem: (value) =>
        workspaceAutoPauseSettingsConflictProblemSchema.parse(value),
      response: {
        kind: 'json',
        decode: (value) => workspaceAutoPauseCommandResponseSchema.parse(value),
      },
    });
    return;
  }
  await apiClient.request({
    path: `${workflowPath(workspaceId, workflowId)}/${command.kind === 'resume' ? 'resume' : 'auto-pause'}`,
    method: command.kind === 'resume' ? 'POST' : 'PUT',
    headers: { 'Idempotency-Key': key },
    body:
      command.kind === 'resume'
        ? workflowResumeRequestSchema.parse(command.body)
        : workflowAutoPauseSettingsRequestSchema.parse(command.body),
    decodeProblem: (value) =>
      command.kind === 'resume'
        ? workflowPauseConflictProblemSchema.parse(value)
        : workflowAutoPauseSettingsConflictProblemSchema.parse(value),
    response: {
      kind: 'json',
      decode: (value) => workflowAutoPauseCommandResponseSchema.parse(value),
    },
  });
}
