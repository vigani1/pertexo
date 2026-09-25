import { useEffect } from 'react';
import { useRouteContext, useSearch } from '@tanstack/react-router';
import { returnPathFrom } from '@/features/auth/return-path.public';
import { SignOutPage } from '@/features/auth/sign-out.public';
import { useLogout } from './use-logout';

export function LogoutRoute() {
  const { apiClient } = useRouteContext({ from: '/logout' });
  const search = useSearch({ from: '/logout' });
  const logout = useLogout(apiClient, {
    returnTo: returnPathFrom(search.returnTo),
  });
  const { completeLogout } = logout;
  useEffect(() => {
    void completeLogout();
  }, [completeLogout]);

  return (
    <SignOutPage
      pending={logout.pending}
      error={logout.error}
      onRetry={logout.requestLogout}
    />
  );
}
