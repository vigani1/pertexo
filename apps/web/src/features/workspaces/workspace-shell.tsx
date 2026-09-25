import type { ReactNode } from 'react';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { Link } from '@tanstack/react-router';
import {
  LayoutGridIcon,
  LogOutIcon,
  SearchIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AccountMenu } from './components/shell/account-menu';
import { WorkspaceBanners } from './components/shell/workspace-banners';
import { WorkspaceMobileBar } from './components/shell/workspace-mobile-bar';
import { WorkspaceSpine } from './components/shell/workspace-spine';
import { WorkspaceSwitcher } from './components/shell/workspace-switcher';

const moreLinkClass =
  'flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-sm text-muted-foreground hover:bg-white/5 hover:text-foreground [&_svg]:size-4';

type WorkspaceShellProps = Readonly<{
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  workspaces: readonly AccessibleWorkspace[];
  /** Running plus waiting runs; undefined when the role can't read runs. */
  liveRunCount: number | undefined;
  /** Steps after the workspace in the breadcrumb, outermost first. */
  crumbs: readonly Readonly<{ key: string; label: ReactNode }>[];
  logoutPending: boolean;
  onLogout: () => void;
  onOpenSearch: () => void;
  children: ReactNode;
}>;

/**
 * The workspace frame: floating spine (bottom bar on phones), a breadcrumb
 * rooted at the in-place workspace switcher, lasting-state banners and the
 * page. It stays mounted while people move between pages.
 */
export function WorkspaceShell({
  user,
  workspace,
  workspaces,
  liveRunCount,
  crumbs,
  logoutPending,
  onLogout,
  onOpenSearch,
  children,
}: WorkspaceShellProps) {
  return (
    <div className="relative min-h-svh bg-background">
      <div className="ambient fixed" aria-hidden="true" />
      <div
        className="warp pointer-events-none fixed inset-0"
        aria-hidden="true"
      />
      <WorkspaceSpine
        workspace={workspace}
        liveRunCount={liveRunCount}
        onOpenSearch={onOpenSearch}
        account={
          <AccountMenu
            user={user}
            workspaceId={workspace.id}
            logoutPending={logoutPending}
            onLogout={onLogout}
          />
        }
      />
      <div className="relative md:pl-21">
        <header className="flex items-center gap-2 px-4 pt-4 sm:px-6 md:px-8 md:pt-5">
          <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
            <ol className="flex min-w-0 items-center gap-2 text-[0.8rem] text-subtle-foreground">
              <li className="min-w-0">
                <WorkspaceSwitcher
                  workspace={workspace}
                  workspaces={workspaces}
                />
              </li>
              {crumbs.map((crumb, index) => (
                <li
                  key={crumb.key}
                  className="flex min-w-0 items-center gap-2"
                  {...(index === crumbs.length - 1
                    ? { 'aria-current': 'page' as const }
                    : {})}
                >
                  <span aria-hidden="true" className="opacity-40">
                    /
                  </span>
                  <span className="truncate">{crumb.label}</span>
                </li>
              ))}
            </ol>
          </nav>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Search"
            className="md:hidden"
            onClick={onOpenSearch}
          >
            <SearchIcon aria-hidden="true" />
          </Button>
        </header>
        <div className="mt-3 px-4 empty:hidden sm:px-6 md:px-8">
          <WorkspaceBanners workspace={workspace} />
        </div>
        <main
          id="main"
          className="mx-auto w-full max-w-368 min-w-0 px-4 pt-6 pb-32 sm:px-6 md:px-8 md:pb-16"
        >
          {children}
        </main>
      </div>
      <WorkspaceMobileBar
        workspace={workspace}
        liveRunCount={liveRunCount}
        more={
          <>
            <Link
              to="/w/$workspaceId/account"
              params={{ workspaceId: workspace.id }}
              className={moreLinkClass}
            >
              <ShieldCheckIcon aria-hidden="true" />
              Account &amp; security
            </Link>
            <Link to="/workspaces" className={moreLinkClass}>
              <LayoutGridIcon aria-hidden="true" />
              All workspaces
            </Link>
            <button
              type="button"
              disabled={logoutPending}
              className={moreLinkClass}
              onClick={onLogout}
            >
              <LogOutIcon aria-hidden="true" />
              {logoutPending ? 'Signing out…' : 'Sign out'}
            </button>
          </>
        }
      />
    </div>
  );
}
