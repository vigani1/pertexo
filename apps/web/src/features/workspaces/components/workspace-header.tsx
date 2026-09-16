import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { ReactNode } from 'react';
import { MobileWorkspaceNavigation } from './mobile-workspace-navigation';

export function WorkspaceHeader({
  user,
  workspace,
  pageTitle,
  actions,
  logoutPending,
  logoutError,
  onChangeWorkspace,
  onLogout,
}: Readonly<{
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  pageTitle: string;
  actions?: ReactNode;
  logoutPending: boolean;
  logoutError?: string;
  onChangeWorkspace: () => void;
  onLogout: () => void;
}>) {
  return (
    <header className="sticky top-0 z-40 flex h-16 min-w-0 items-center gap-3 border-b border-white/8 bg-background/70 px-4 backdrop-blur-xl sm:px-6">
      <MobileWorkspaceNavigation
        user={user}
        workspace={workspace}
        logoutPending={logoutPending}
        {...(logoutError === undefined ? {} : { logoutError })}
        onChangeWorkspace={onChangeWorkspace}
        onLogout={onLogout}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-muted-foreground">
          {workspace.name}
        </p>
        <p className="truncate font-heading text-base font-semibold text-foreground">
          {pageTitle}
        </p>
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
