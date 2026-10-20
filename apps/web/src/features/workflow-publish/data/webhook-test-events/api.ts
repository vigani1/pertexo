import {
  webhookTestEventStartedSchema,
  webhookTestEventSnapshotSchema,
  type WebhookAuthentication,
} from '@pertexo/contracts';
import type { SampleScope } from '../samples/api';
function path(scope: SampleScope, nodeId: string, id?: string): `/v1${string}` {
  const root =
    `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/workflows/${encodeURIComponent(scope.workflowId)}/draft/nodes/${encodeURIComponent(nodeId)}/webhook-test-events` as const;
  return id === undefined ? root : `${root}/${encodeURIComponent(id)}`;
}
export function startWebhookTest(
  scope: SampleScope,
  nodeId: string,
  body: {
    expectedDraftRevision: number;
    authentication: WebhookAuthentication;
  },
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: path(scope, nodeId),
    method: 'POST',
    body,
    signal,
    response: {
      kind: 'json',
      decode: (value) => webhookTestEventStartedSchema.parse(value),
    },
  });
}
export function readWebhookTest(
  scope: SampleScope,
  nodeId: string,
  id: string,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: path(scope, nodeId, id),
    signal,
    response: {
      kind: 'json',
      decode: (value) => webhookTestEventSnapshotSchema.parse(value),
    },
  });
}
export function stopWebhookTest(
  scope: SampleScope,
  nodeId: string,
  id: string,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: path(scope, nodeId, id),
    method: 'DELETE',
    signal,
    response: { kind: 'empty' },
  });
}
