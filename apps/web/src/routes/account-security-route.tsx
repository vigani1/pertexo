import {
  useLoaderData,
  useRouteContext,
  useSearch,
} from '@tanstack/react-router';
import { AccountSecurityPage } from '@/features/auth/account-security.public';

export function AccountSecurityRoute() {
  const { apiClient } = useRouteContext({ from: '/account/security' });
  const user = useLoaderData({ from: '/account/security' });
  const search = useSearch({ from: '/account/security' });
  return (
    <AccountSecurityPage
      key={user.id}
      apiClient={apiClient}
      user={user}
      {...(search.linked ? { linkOutcome: 'returned' as const } : {})}
      {...(search.linkError ? { linkOutcome: 'failed' as const } : {})}
    />
  );
}
