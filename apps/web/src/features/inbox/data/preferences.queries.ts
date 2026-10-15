import { queryOptions } from '@tanstack/react-query';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import { inboxKeys } from './inbox.queries';
import {
  readNotificationPreferences,
  readNotificationSubscription,
  type NoticeSubject,
} from './preferences.api';
export function notificationPreferencesQueryOptions(scope: WorkspaceApiScope) {
  return queryOptions({
    queryKey: [
      ...inboxKeys.scope(scope.userId, scope.workspaceId),
      'preferences',
    ],
    queryFn: ({ signal }) => readNotificationPreferences(scope, signal),
    staleTime: 15_000,
  });
}
export function notificationSubscriptionQueryOptions(
  scope: WorkspaceApiScope,
  subject: NoticeSubject,
) {
  return queryOptions({
    queryKey: [
      ...inboxKeys.scope(scope.userId, scope.workspaceId),
      'subscription',
      subject.subjectKind,
      subject.subjectId,
    ],
    queryFn: ({ signal }) =>
      readNotificationSubscription(scope, subject, signal),
    staleTime: 0,
  });
}
