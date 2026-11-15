import { QUERY_FRESHNESS } from '@/lib/api/query-timings';
import { queryOptions } from '@tanstack/react-query';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import { inboxKeys } from './inbox-keys';
import {
  readNotificationPreferences,
  readNotificationSubscription,
  type NoticeSubject,
} from './notice-preferences.api';
export function notificationPreferencesQueryOptions(scope: WorkspaceApiScope) {
  return queryOptions({
    queryKey: inboxKeys.preferences(scope.userId, scope.workspaceId),
    queryFn: ({ signal }) => readNotificationPreferences(scope, signal),
    staleTime: QUERY_FRESHNESS.recent,
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
    staleTime: QUERY_FRESHNESS.none,
  });
}
