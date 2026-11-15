import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  noticeDefaultsRequestSchema,
  type NoticePreferencesRequest,
  type NoticeSubscription,
  type NoticeSubscriptionRequest,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
import {
  acceptedNotificationSchedule,
  type ScheduleTarget,
} from '../model/email-schedule';
import {
  replaceNotificationDefaults,
  replaceNotificationPreferences,
  replaceNotificationSubscription,
  unsubscribeFromNotices,
  type NoticeSubject,
} from './notice-preferences.api';
import {
  notificationPreferencesQueryOptions,
  notificationSubscriptionQueryOptions,
} from './notice-preferences.queries';
import { inboxKeys } from './inbox.queries';

/**
 * Turns personal notice email off with an unsubscribe link's token. The
 * token is a capability, so it never enters a query key; success refreshes
 * any personal schedules this tab has cached.
 */
export function useNoticeUnsubscribe(
  apiClient: ApiClient,
  token: string | null,
) {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: () =>
      token === null
        ? Promise.reject(new Error('Unavailable link'))
        : unsubscribeFromNotices(apiClient, token),
    retry: false,
    onSuccess: () =>
      cache.invalidateQueries({
        predicate: ({ queryKey }) =>
          queryKey[0] === 'identity' &&
          queryKey[4] === 'inbox' &&
          queryKey[5] === 'preferences',
      }),
  });
}

/**
 * Saves a personal email schedule or the workspace default. The accepted
 * revision goes into the cached snapshot at once; `onAccepted` updates the
 * editor, then the inbox refetches.
 */
export function useNotificationScheduleSave(
  scope: WorkspaceApiScope,
  target: ScheduleTarget,
  onAccepted: (result: Readonly<{ revision: number }>) => void,
) {
  const cache = useQueryClient();
  return useRetainedCommand(
    (body: NoticePreferencesRequest, key: string) =>
      target === 'personal'
        ? replaceNotificationPreferences(scope, body, key)
        : replaceNotificationDefaults(
            scope,
            noticeDefaultsRequestSchema.parse(body),
            key,
          ),
    async (result, body) => {
      cache.setQueryData(
        notificationPreferencesQueryOptions(scope).queryKey,
        (current) =>
          acceptedNotificationSchedule(current, { target, body, result }),
      );
      onAccepted(result);
      await cache.invalidateQueries({
        queryKey: inboxKeys.scope(scope.userId, scope.workspaceId),
      });
    },
    { action: 'saving notification choices' },
  );
}

/** Saves following and muting one subject; a newer cached revision wins. */
export function useNotificationSubscriptionSave(
  scope: WorkspaceApiScope,
  subject: NoticeSubject,
  onAccepted: (accepted: NoticeSubscription) => void,
) {
  const cache = useQueryClient();
  return useRetainedCommand(
    (body: NoticeSubscriptionRequest, key: string) =>
      replaceNotificationSubscription(scope, subject, body, key),
    async (result, body) => {
      const accepted = {
        revision: result.revision,
        followed: body.followed,
        muted: body.muted,
      };
      cache.setQueryData(
        notificationSubscriptionQueryOptions(scope, subject).queryKey,
        (current) =>
          current !== undefined && current.revision > result.revision
            ? current
            : accepted,
      );
      onAccepted(accepted);
      await cache.invalidateQueries({
        queryKey: inboxKeys.scope(scope.userId, scope.workspaceId),
      });
    },
    { action: 'saving this personal subscription' },
  );
}
