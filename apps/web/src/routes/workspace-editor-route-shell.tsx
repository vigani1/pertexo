import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import {
  MobileWorkspaceNavigation,
  WorkspaceShell,
} from '@/features/workspaces/public';
import type { ApiClient } from '@/lib/api/client';
import { useLogout } from './use-logout';

export function WorkspaceEditorRouteShell({
  apiClient,
  user,
  workspace,
  children,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  children: (mobileNavigation: ReactNode) => ReactNode;
}>) {
  const navigate = useNavigate();
  const logout = useLogout(apiClient);
  const navigation = (
    <MobileWorkspaceNavigation
      user={user}
      workspace={workspace}
      triggerVisibility="always"
      logoutPending={logout.pending}
      {...(logout.error === undefined ? {} : { logoutError: logout.error })}
      onChangeWorkspace={() => void navigate({ to: '/workspaces' })}
      onLogout={logout.requestLogout}
    />
  );
  return (
    <WorkspaceShell
      user={user}
      workspace={workspace}
      pageTitle="Workflow editor"
      layout="editor"
      logoutPending={logout.pending}
      {...(logout.error === undefined ? {} : { logoutError: logout.error })}
      onChangeWorkspace={() => void navigate({ to: '/workspaces' })}
      onLogout={logout.requestLogout}
    >
      {children(navigation)}
    </WorkspaceShell>
  );
}
