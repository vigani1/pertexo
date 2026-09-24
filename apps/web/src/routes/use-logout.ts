import { useCallback, useRef, useState } from 'react';
import {
  useNavigate,
  useRouteContext,
  useRouter,
} from '@tanstack/react-router';
import {
  endBrowserSession,
  logoutErrorMessage,
} from '@/features/auth/session-actions.public';
import type { ApiClient } from '@/lib/api/client';

export function useLogout(
  apiClient: ApiClient,
  options: Readonly<{ onError?: (message: string) => void }> = {},
) {
  const { onError } = options;
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
      const message = logoutErrorMessage(cause);
      setError(message);
      setPending(false);
      onError?.(message);
    }
  }, [apiClient, navigate, onError, queryClient, router]);

  const requestLogout = useCallback(() => {
    if (router.state.location.pathname === '/logout') {
      void completeLogout();
      return;
    }
    void navigate({ to: '/logout' });
  }, [completeLogout, navigate, router]);

  return { pending, error, requestLogout, completeLogout };
}
