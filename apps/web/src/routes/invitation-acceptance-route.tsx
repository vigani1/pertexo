import {
  useLoaderData,
  useLocation,
  useNavigate,
  useRouteContext,
} from '@tanstack/react-router';
import { useCallback } from 'react';
import { InvitationAcceptancePage } from '@/features/workspace-invitations/public';

export function InvitationAcceptanceRoute() {
  const { apiClient } = useRouteContext({ from: '/invitations/accept' });
  const { signInMethod } = useLoaderData({ from: '/invitations/accept' });
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
      signInMethod={signInMethod}
      clearFragment={clearFragment}
      navigateToProvider={navigateToProvider}
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
