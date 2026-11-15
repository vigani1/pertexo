import {
  noticePreferencesResponseSchema,
  noticeCommandResponseSchema,
  noticeSubscriptionSchema,
  type NoticePreferencesRequest,
  type NoticeDefaultsRequest,
  type NoticeSubscriptionRequest,
  type NoticeSubjectParams,
} from '@pertexo/contracts';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
export type NoticeSubject = Pick<
  NoticeSubjectParams,
  'subjectKind' | 'subjectId'
>;
function path(scope: WorkspaceApiScope): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/notifications`;
}
export function readNotificationPreferences(
  scope: WorkspaceApiScope,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: `${path(scope)}/preferences`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => noticePreferencesResponseSchema.parse(value),
    },
  });
}
export function replaceNotificationPreferences(
  scope: WorkspaceApiScope,
  body: NoticePreferencesRequest,
  key: string,
) {
  return scope.apiClient.request({
    path: `${path(scope)}/preferences`,
    method: 'PUT',
    headers: { 'Idempotency-Key': key },
    body,
    response: {
      kind: 'json',
      decode: (value) => noticeCommandResponseSchema.parse(value),
    },
  });
}
export function replaceNotificationDefaults(
  scope: WorkspaceApiScope,
  body: NoticeDefaultsRequest,
  key: string,
) {
  return scope.apiClient.request({
    path: `${path(scope)}/defaults`,
    method: 'PUT',
    headers: { 'Idempotency-Key': key },
    body,
    response: {
      kind: 'json',
      decode: (value) => noticeCommandResponseSchema.parse(value),
    },
  });
}
function subjectPath(
  scope: WorkspaceApiScope,
  subject: NoticeSubject,
): `/v1${string}` {
  return `${path(scope)}/subjects/${subject.subjectKind}/${encodeURIComponent(subject.subjectId)}`;
}
export function readNotificationSubscription(
  scope: WorkspaceApiScope,
  subject: NoticeSubject,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: subjectPath(scope, subject),
    signal,
    response: {
      kind: 'json',
      decode: (value) => noticeSubscriptionSchema.parse(value),
    },
  });
}
export function replaceNotificationSubscription(
  scope: WorkspaceApiScope,
  subject: NoticeSubject,
  body: NoticeSubscriptionRequest,
  key: string,
) {
  return scope.apiClient.request({
    path: subjectPath(scope, subject),
    method: 'PUT',
    headers: { 'Idempotency-Key': key },
    body,
    response: {
      kind: 'json',
      decode: (value) => noticeCommandResponseSchema.parse(value),
    },
  });
}
