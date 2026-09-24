import { useEffect } from 'react';
import { useRouteContext } from '@tanstack/react-router';
import { SignOutPage } from '@/features/auth/sign-out.public';
import { useLogout } from './use-logout';

export function LogoutRoute() {
  const { apiClient } = useRouteContext({ from: '/logout' });
  const logout = useLogout(apiClient);
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
