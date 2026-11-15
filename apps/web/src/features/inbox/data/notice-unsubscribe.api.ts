import { noticeUnsubscribeResponseSchema } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';

/** The token is the unsubscribe link's capability; no session is needed. */
export function unsubscribeFromNotices(apiClient: ApiClient, token: string) {
  return apiClient.request({
    path: '/v1/notifications/unsubscribe',
    method: 'POST',
    csrf: 'external',
    headers: { 'X-Pertexo-Unsubscribe-Key': token },
    body: {},
    response: {
      kind: 'json',
      decode: (value) => noticeUnsubscribeResponseSchema.parse(value),
    },
  });
}
