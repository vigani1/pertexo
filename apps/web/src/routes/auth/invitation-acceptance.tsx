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
  const openWorkspace = useCallback(
    (workspaceId: string) => {
      void navigate({
        to: '/w/$workspaceId',
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
      openWorkspace={openWorkspace}
      openSignIn={() => {
        void navigate({ to: '/login', search: RETURN_HERE });
      }}
      openFreshSignIn={() => {
        void navigate({ to: '/logout', search: RETURN_HERE });
      }}
      openSignUp={() => {
        void navigate({ to: '/sign-up', search: RETURN_HERE });
      }}
      openWorkspaceDiscovery={() => {
        void navigate({ to: '/workspaces' });
      }}
    />
  );
}

/** Sign-in, sign-up and verification all come back to the invitation. */
const RETURN_HERE = { returnTo: '/invitations/accept' } as const;

function readToken(hash: string): string | undefined {
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!value.startsWith('token=')) return undefined;
  try {
    return decodeURIComponent(value.slice('token='.length));
  } catch {
    return undefined;
  }
}
