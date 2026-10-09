import { useLoaderData, useRouteContext } from '@tanstack/react-router';
import { PasswordResetPage } from '@/features/auth/password-reset.public';

export function PasswordResetRoute() {
  const { apiClient } = useRouteContext({ from: '/_stage/reset-password' });
  const search = useLoaderData({ from: '/_stage/reset-password' });
  return (
    <PasswordResetPage
      key={search.token ?? 'missing-token'}
      apiClient={apiClient}
      {...(search.token === undefined ? {} : { token: search.token })}
    />
  );
}
