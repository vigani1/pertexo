import { useLoaderData, useRouteContext } from '@tanstack/react-router';
import { PasswordResetPage } from '@/features/auth/password-reset.public';

export function PasswordResetRoute() {
  const { apiClient } = useRouteContext({ from: '/reset-password' });
  const search = useLoaderData({ from: '/reset-password' });
  return (
    <PasswordResetPage
      key={search.token ?? 'missing-token'}
      apiClient={apiClient}
      {...(search.token === undefined ? {} : { token: search.token })}
    />
  );
}
