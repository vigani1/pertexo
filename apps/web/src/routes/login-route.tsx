import { useEffect } from 'react';
import { useRouteContext, useSearch } from '@tanstack/react-router';
import { LoginPage, loginNoticeFrom } from '@/features/auth/login.public';
import { publishSessionChange } from '@/features/auth/session-sync.public';

export function LoginRoute() {
  const { apiClient } = useRouteContext({ from: '/login' });
  const search = useSearch({ from: '/login' });
  useEffect(() => {
    if (search.emailChanged) publishSessionChange();
  }, [search.emailChanged]);
  return (
    <LoginPage
      apiClient={apiClient}
      notice={loginNoticeFrom(search)}
      navigateToProvider={(authorizationUrl) => {
        window.location.assign(authorizationUrl);
      }}
      onAuthenticated={() => {
        // A full navigation starts the signed-in app from a clean slate.
        window.location.assign('/');
      }}
    />
  );
}
