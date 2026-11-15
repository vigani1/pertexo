import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { unsubscribeFromNotices } from './notice-unsubscribe.api';
import { isNotificationPreferencesKey } from './inbox-keys';

/**
 * Turns personal notice email off with an unsubscribe link's token. The
 * token is a capability, so it never enters a query key, and the link
 * names no person or workspace: success refreshes every personal schedule
 * this tab has cached.
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
        predicate: ({ queryKey }) => isNotificationPreferencesKey(queryKey),
      }),
  });
}
