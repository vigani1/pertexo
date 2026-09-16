import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
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
  return (
    <div className="app-stage relative min-h-svh overflow-x-clip lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[17.5rem_minmax(0,1fr)]">
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
          className={cn(
            'relative z-10 min-w-0',
            layout === 'editor'
              ? 'h-[calc(100svh-4rem)] min-h-[36rem]'
              : 'mx-auto w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-10',
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
