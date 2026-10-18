import {
  workflowPromotionSettingsSchema,
  workflowPromotionTargetResultSchema,
  workflowPromotionCandidatesSchema,
  workflowPromotionHistorySchema,
  workflowPromotionPreviewSchema,
  workflowPromotionResultSchema,
  type WorkflowPromotionTarget,
  type WorkflowPromotionPreviewRequest,
  type WorkflowPromotionApply,
} from '@pertexo/contracts';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
export type PromotionScope = WorkspaceApiScope;
function path(scope: PromotionScope, action: string): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/promotions/${action}`;
}
export function readPromotionSettings(
  scope: PromotionScope,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: path(scope, 'settings'),
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowPromotionSettingsSchema.parse(value),
    },
  });
}
export function setPromotionTarget(
  scope: PromotionScope,
  body: WorkflowPromotionTarget,
  key: string,
) {
  return scope.apiClient.request({
    path: path(scope, 'settings'),
    method: 'PUT',
    headers: { 'Idempotency-Key': key },
    body,
    response: {
      kind: 'json',
      decode: (value) => workflowPromotionTargetResultSchema.parse(value),
    },
  });
}
export function readPromotionCandidates(
  scope: PromotionScope,
  after: string | null,
  search: string,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({ limit: '25', search });
  if (after !== null) query.set('after', after);
  return scope.apiClient.request({
    path: path(scope, `candidates?${query}`),
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowPromotionCandidatesSchema.parse(value),
    },
  });
}
export function readPromotionHistory(
  scope: PromotionScope,
  after: string | null,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({ limit: '20' });
  if (after !== null) query.set('after', after);
  return scope.apiClient.request({
    path: path(scope, `history?${query}`),
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowPromotionHistorySchema.parse(value),
    },
  });
}
export function previewPromotion(
  scope: PromotionScope,
  body: WorkflowPromotionPreviewRequest,
) {
  return scope.apiClient.request({
    path: path(scope, 'preview'),
    method: 'POST',
    body,
    response: {
      kind: 'json',
      decode: (value) => workflowPromotionPreviewSchema.parse(value),
    },
  });
}
export function applyPromotion(
  scope: PromotionScope,
  body: WorkflowPromotionApply,
  key: string,
) {
  return scope.apiClient.request({
    path: path(scope, 'apply'),
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body,
    response: {
      kind: 'json',
      decode: (value) => workflowPromotionResultSchema.parse(value),
    },
  });
}

export function readPromotionVersions(
  scope: PromotionScope,
  workflowId: string,
  beforeVersionNumber: number | null,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({ workflowId, limit: '25' });
  if (beforeVersionNumber !== null)
    query.set('beforeVersionNumber', String(beforeVersionNumber));
  return scope.apiClient.request({
    path: path(scope, `candidates?${query}`),
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowPromotionCandidatesSchema.parse(value),
    },
  });
}
