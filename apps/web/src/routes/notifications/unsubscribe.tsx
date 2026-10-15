import { useRouteContext } from '@tanstack/react-router';
import { NoticeUnsubscribePage } from '@/features/inbox/unsubscribe.public';
export function NoticeUnsubscribeRoute() {
  const { apiClient, unsubscribeToken } = useRouteContext({
    from: '/notifications/unsubscribe',
  });
  return (
    <NoticeUnsubscribePage apiClient={apiClient} token={unsubscribeToken} />
  );
}
