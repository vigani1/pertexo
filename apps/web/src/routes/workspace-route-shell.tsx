import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { WorkspaceShell } from '@/features/workspaces/public';
import type { ApiClient } from '@/lib/api/client';
import { useLogout } from './use-logout';

export function WorkspaceRouteShell({
  apiClient,
  user,
  workspace,
  pageTitle,
  layout = 'page',
  headerActions,
  children,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  pageTitle: string;
  layout?: 'page' | 'editor';
  headerActions?: ReactNode;
  children: ReactNode;
}>) {
  const navigate = useNavigate();
  const logout = useLogout(apiClient);
  return (
    <WorkspaceShell
      user={user}
      workspace={workspace}
      pageTitle={pageTitle}
      layout={layout}
      {...(headerActions === undefined ? {} : { headerActions })}
      logoutPending={logout.pending}
      {...(logout.error === undefined ? {} : { logoutError: logout.error })}
      onChangeWorkspace={() => void navigate({ to: '/workspaces' })}
      onLogout={logout.requestLogout}
    >
      {children}
    </WorkspaceShell>
  );
}
