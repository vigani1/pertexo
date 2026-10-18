import { createRoute } from '@tanstack/react-router';
import { lazyRoute } from '@/components/patterns/app-update/lazy';
import { rootRoute } from '../root/route';
export const noticeUnsubscribeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'notifications/unsubscribe',
  head: () => ({
    meta: [
      { title: 'Notification email — Pertexo' },
      { name: 'referrer', content: 'no-referrer' },
    ],
  }),
  beforeLoad: ({ location }) => {
    const token = location.hash.replace(/^#/u, '');
    return {
      unsubscribeToken: /^[A-Za-z0-9_-]{1,4096}$/u.test(token) ? token : null,
    };
  },
  component: lazyRoute(() => import('./unsubscribe'), 'NoticeUnsubscribeRoute'),
});
