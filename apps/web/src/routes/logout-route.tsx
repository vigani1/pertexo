import { useEffect } from 'react';
import { useRouteContext } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { useLogout } from './use-logout';

export function LogoutRoute() {
  const { apiClient } = useRouteContext({ from: '/logout' });
  const logout = useLogout(apiClient);
  const { completeLogout } = logout;
  useEffect(() => {
    void completeLogout();
  }, [completeLogout]);

  return (
    <main
      id="main"
      className="app-stage grid min-h-svh place-items-center px-6"
    >
      {logout.error === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          Signing out…
        </p>
      ) : (
        <section className="flex max-w-md flex-col items-start gap-4">
          <h1 className="text-3xl font-semibold">Sign out did not complete</h1>
          <p role="alert" className="text-sm text-destructive">
            {logout.error}
          </p>
          <Button
            type="button"
            disabled={logout.pending}
            onClick={logout.requestLogout}
          >
            {logout.pending ? 'Retrying…' : 'Retry sign out'}
          </Button>
        </section>
      )}
    </main>
  );
}
