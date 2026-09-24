import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { ReactNode } from 'react';
import { WorkspaceHeader } from './components/workspace-header';
import { WorkspaceSidebarContent } from './components/workspace-sidebar-content';

type WorkspaceShellProps = Readonly<{
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  pageTitle: string;
  layout?: 'page' | 'editor';
  headerActions?: ReactNode;
  logoutPending: boolean;
  logoutError?: string;
  onChangeWorkspace: () => void;
  onLogout: () => void;
  children: ReactNode;
}>;

export function WorkspaceShell({
  user,
  workspace,
  pageTitle,
  layout = 'page',
  headerActions,
  logoutPending,
  logoutError,
  onChangeWorkspace,
  onLogout,
  children,
}: WorkspaceShellProps) {
  if (layout === 'editor') {
    return (
      <div className="app-stage relative h-svh min-h-0 overflow-hidden">
        <div className="workspace-shell-ambient" aria-hidden="true" />
        <main id="main" className="relative z-10 h-full min-h-0 min-w-0">
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className="app-stage relative min-h-svh overflow-x-clip lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)]">
      <aside className="glass-panel sticky top-0 z-40 hidden h-svh min-h-0 rounded-none border-y-0 border-l-0 shadow-[0_0_24px_color-mix(in_srgb,var(--primary)_5%,transparent)] lg:flex lg:flex-col">
        <WorkspaceSidebarContent
          user={user}
          workspace={workspace}
          logoutPending={logoutPending}
          {...(logoutError === undefined ? {} : { logoutError })}
          onChangeWorkspace={onChangeWorkspace}
          onLogout={onLogout}
        />
      </aside>

      <div className="relative min-w-0 lg:col-start-2">
        <div className="workspace-shell-ambient" aria-hidden="true" />
        <WorkspaceHeader
          user={user}
          workspace={workspace}
          pageTitle={pageTitle}
          {...(headerActions === undefined ? {} : { actions: headerActions })}
          logoutPending={logoutPending}
          {...(logoutError === undefined ? {} : { logoutError })}
          onChangeWorkspace={onChangeWorkspace}
          onLogout={onLogout}
        />
        <main
          id="main"
          className="relative z-10 mx-auto w-full max-w-7xl min-w-0 px-4 py-6 sm:px-6 sm:py-8 lg:px-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
