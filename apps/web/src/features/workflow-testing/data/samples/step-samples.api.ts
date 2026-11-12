import {
  stepSampleListResponseSchema,
  stepSampleResponseSchema,
  stepSampleCommandResponseSchema,
  type StepSampleListResponse,
  type StepSampleResponse,
  type StepSampleCommandResponse,
  type StepSampleWriteRequest,
  type StepSampleDeleteRequest,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
export type SampleScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
}>;
function samplePath(scope: SampleScope, nodeId?: string): `/v1${string}` {
  const root: `/v1${string}` = `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/workflows/${encodeURIComponent(scope.workflowId)}/draft`;
  return nodeId === undefined
    ? `${root}/samples`
    : `${root}/nodes/${encodeURIComponent(nodeId)}/sample`;
}
export function listStepSamples(
  scope: SampleScope,
  signal: AbortSignal,
): Promise<StepSampleListResponse> {
  return scope.apiClient.request({
    path: samplePath(scope),
    signal,
    response: {
      kind: 'json',
      decode: (value) => stepSampleListResponseSchema.parse(value),
    },
  });
}
export function getStepSample(
  scope: SampleScope,
  nodeId: string,
  signal: AbortSignal,
): Promise<StepSampleResponse> {
  return scope.apiClient.request({
    path: samplePath(scope, nodeId),
    signal,
    response: {
      kind: 'json',
      decode: (value) => stepSampleResponseSchema.parse(value),
    },
  });
}
export type SampleCommand =
  | Readonly<{ kind: 'put'; body: StepSampleWriteRequest }>
  | Readonly<{ kind: 'remove'; body: StepSampleDeleteRequest }>;
export function changeStepSample({
  scope,
  nodeId,
  command,
  key,
  signal,
}: Readonly<{
  scope: SampleScope;
  nodeId: string;
  command: SampleCommand;
  key: string;
  signal: AbortSignal;
}>): Promise<StepSampleCommandResponse> {
  return scope.apiClient.request({
    path: samplePath(scope, nodeId),
    method: command.kind === 'put' ? 'PUT' : 'DELETE',
    body: command.body,
    headers: { 'Idempotency-Key': key },
    signal,
    response: {
      kind: 'json',
      decode: (value) => stepSampleCommandResponseSchema.parse(value),
    },
  });
}
