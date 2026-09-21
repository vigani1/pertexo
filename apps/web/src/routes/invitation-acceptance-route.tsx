import {
  useLocation,
  useNavigate,
  useRouteContext,
} from '@tanstack/react-router';
import { useCallback } from 'react';
import { InvitationAcceptancePage } from '@/features/workspace-invitations/public';

export function InvitationAcceptanceRoute() {
  const { apiClient } = useRouteContext({ from: '/invitations/accept' });
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const initialToken = readToken(hash);
  const clearFragment = useCallback(() => {
    void navigate({
      to: '/invitations/accept',
      hash: '',
      replace: true,
    });
  }, [navigate]);
  const navigateToProvider = useCallback((url: string) => {
    window.location.assign(url);
  }, []);
  const openWorkspace = useCallback(
    (workspaceId: string) => {
      void navigate({
        to: '/w/$workspaceId/workflows',
        params: { workspaceId },
      });
    },
    [navigate],
  );
  return (
    <InvitationAcceptancePage
      apiClient={apiClient}
      {...(initialToken === undefined ? {} : { initialToken })}
      clearFragment={clearFragment}
      navigateToProvider={navigateToProvider}
      openWorkspace={openWorkspace}
      openSignIn={() => {
        void navigate({ to: '/login' });
      }}
      openWorkspaceDiscovery={() => {
        void navigate({ to: '/workspaces' });
      }}
    />
  );
}

function readToken(hash: string): string | undefined {
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!value.startsWith('token=')) return undefined;
  try {
    return decodeURIComponent(value.slice('token='.length));
  } catch {
    return undefined;
  }
}
