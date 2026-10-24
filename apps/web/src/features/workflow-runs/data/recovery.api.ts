import {
  workflowRecoveryPreviewSchema,
  workflowRecoveryRequestSchema,
  workflowRecoveryUnavailableProblemSchema,
  workflowRunStartResponseSchema,
  type WorkflowRecoveryRequest,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
function path(workspaceId: string, runId: string): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}`;
}
export function getRunRecovery(
  client: ApiClient,
  workspaceId: string,
  runId: string,
  signal?: AbortSignal,
) {
  return client.request({
    path: `${path(workspaceId, runId)}/recovery`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => workflowRecoveryPreviewSchema.parse(value),
    },
  });
}
export function recoverRun({
  client,
  workspaceId,
  runId,
  body,
  key,
}: Readonly<{
  client: ApiClient;
  workspaceId: string;
  runId: string;
  body: WorkflowRecoveryRequest;
  key: string;
}>) {
  return client.request({
    path: `${path(workspaceId, runId)}/recover`,
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: workflowRecoveryRequestSchema.parse(body),
    decodeProblem: (value) =>
      workflowRecoveryUnavailableProblemSchema.parse(value),
    response: {
      kind: 'json',
      decode: (value) => workflowRunStartResponseSchema.parse(value),
    },
  });
}
