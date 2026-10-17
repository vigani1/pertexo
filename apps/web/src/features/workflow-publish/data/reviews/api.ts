import {
  publicationReviewSchema,
  publicationReviewOverviewSchema,
  publicationReviewDetailSchema,
  type PublicationReviewDecision,
} from '@pertexo/contracts';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
export type ReviewScope = WorkspaceApiScope;
function base(scope: ReviewScope): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}`;
}
export function readReviewOverview(
  scope: ReviewScope,
  workflowId: string,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: `${base(scope)}/workflows/${encodeURIComponent(workflowId)}/publication-review`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => publicationReviewOverviewSchema.parse(value),
    },
  });
}
export function readPublicationReview(
  scope: ReviewScope,
  reviewId: string,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: `${base(scope)}/publication-requests/${encodeURIComponent(reviewId)}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => publicationReviewDetailSchema.parse(value),
    },
  });
}
export function requestPublicationReview(
  scope: ReviewScope,
  workflowId: string,
  input: { etag: string; idempotencyKey: string; note: string },
) {
  return scope.apiClient.request({
    path: `${base(scope)}/workflows/${encodeURIComponent(workflowId)}/publication-review`,
    method: 'POST',
    headers: {
      'If-Match': input.etag,
      'Idempotency-Key': input.idempotencyKey,
    },
    body: { note: input.note },
    response: {
      kind: 'json',
      decode: (value) => publicationReviewSchema.parse(value),
    },
  });
}
export function decidePublicationReview(
  scope: ReviewScope,
  reviewId: string,
  body: PublicationReviewDecision,
  key: string,
) {
  return scope.apiClient.request({
    path: `${base(scope)}/publication-requests/${encodeURIComponent(reviewId)}/decision`,
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body,
    response: {
      kind: 'json',
      decode: (value) => publicationReviewSchema.parse(value),
    },
  });
}
