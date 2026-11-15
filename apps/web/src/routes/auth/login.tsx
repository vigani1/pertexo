import { useEffect } from 'react';
import { useRouteContext, useSearch } from '@tanstack/react-router';
import { LoginPage } from '@/features/auth/pages/login';
import { loginNoticeFrom } from '@/features/auth/public';
import {
  allowlistedReturnPath,
  publishSessionChange,
} from '@/features/auth/auth-routing.public';

export function LoginRoute() {
  const { apiClient } = useRouteContext({ from: '/_stage/login' });
  const search = useSearch({ from: '/_stage/login' });
  // Router search keeps unvalidated raw keys, so check the value again.
  const returnTo = allowlistedReturnPath(search.returnTo);
  useEffect(() => {
    if (search.emailChanged) publishSessionChange();
  }, [search.emailChanged]);
  return (
    <LoginPage
      apiClient={apiClient}
      notice={loginNoticeFrom(search)}
      returnTo={returnTo}
      navigateToProvider={(authorizationUrl) => {
        window.location.assign(authorizationUrl);
      }}
      onAuthenticated={() => {
        // A page paused in another tab checks who signed in and resumes.
        publishSessionChange();
        // A full navigation starts the signed-in app from a clean slate, at
        // the allowlisted page that asked for the sign-in.
        window.location.assign(returnTo ?? '/');
      }}
    />
  );
}
