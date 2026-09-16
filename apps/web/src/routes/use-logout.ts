import { useCallback, useRef, useState } from 'react';
import {
  useNavigate,
  useRouteContext,
  useRouter,
} from '@tanstack/react-router';
import { endBrowserSession, logoutErrorMessage } from '@/features/auth/public';
import type { ApiClient } from '@/lib/api/client';

export function useLogout(apiClient: ApiClient) {
  const { queryClient } = useRouteContext({ from: '__root__' });
  const navigate = useNavigate();
  const router = useRouter();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const completeLogout = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(undefined);
    try {
      await endBrowserSession(apiClient, queryClient);
      await navigate({ to: '/login', replace: true });
      await router.invalidate();
    } catch (cause) {
      pendingRef.current = false;
      setError(logoutErrorMessage(cause));
      setPending(false);
    }
  }, [apiClient, navigate, queryClient, router]);

  const requestLogout = useCallback(() => {
    if (router.state.location.pathname === '/logout') {
      void completeLogout();
      return;
    }
    void navigate({ to: '/logout' });
  }, [completeLogout, navigate, router]);

  return { pending, error, requestLogout, completeLogout };
}
