import {
  nodeTestExecuteAcceptedResponseSchema,
  nodeTestRequestSchema,
  nodeValidationResponseSchema,
  previewRunResponseSchema,
  type NodeTestExecuteAcceptedResponse,
  type NodeValidationResponse,
  type PreviewRunResponse,
} from '@pertexo/contracts/schemas/node-testing';
import type { ApiClient } from '@/lib/api/client';

function nodeTestPath(
  workspaceId: string,
  workflowId: string,
  nodeId: string,
): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/draft/nodes/${encodeURIComponent(nodeId)}/test`;
}

export function validateWorkflowNode(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  input: Readonly<{
    nodeId: string;
    expectedRevision: number;
    sampleInput?: unknown;
    signal?: AbortSignal;
  }>,
): Promise<NodeValidationResponse> {
  return apiClient.request({
    path: nodeTestPath(workspaceId, workflowId, input.nodeId),
    method: 'POST',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    body: nodeTestRequestSchema.parse({
      mode: 'validate',
      expectedRevision: input.expectedRevision,
      ...(input.sampleInput === undefined
        ? {}
        : { sampleInput: input.sampleInput }),
    }),
    response: {
      kind: 'json',
      decode: (value) => nodeValidationResponseSchema.parse(value),
    },
  });
}

export function executeWorkflowNodePreview(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  input: Readonly<{
    nodeId: string;
    expectedRevision: number;
    value: unknown;
    idempotencyKey: string;
    signal?: AbortSignal;
  }>,
): Promise<NodeTestExecuteAcceptedResponse> {
  return apiClient.request({
    path: nodeTestPath(workspaceId, workflowId, input.nodeId),
    method: 'POST',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    headers: { 'Idempotency-Key': input.idempotencyKey },
    body: nodeTestRequestSchema.parse({
      mode: 'test_execute',
      expectedRevision: input.expectedRevision,
      input: { kind: 'manual', value: input.value },
      acknowledgeSideEffects: true,
    }),
    response: {
      kind: 'json',
      decode: (value) => nodeTestExecuteAcceptedResponseSchema.parse(value),
    },
  });
}

export function getWorkflowNodePreview(
  apiClient: ApiClient,
  workspaceId: string,
  previewRunId: string,
  signal?: AbortSignal,
): Promise<PreviewRunResponse> {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/previews/${encodeURIComponent(previewRunId)}`,
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => previewRunResponseSchema.parse(value),
    },
  });
}
