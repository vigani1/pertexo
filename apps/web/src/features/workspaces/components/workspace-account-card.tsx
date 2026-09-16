import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { LogOutIcon, PanelsTopLeftIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function WorkspaceAccountCard({
  user,
  workspace,
  logoutPending,
  logoutError,
  onChangeWorkspace,
  onLogout,
}: Readonly<{
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  logoutPending: boolean;
  logoutError?: string;
  onChangeWorkspace: () => void;
  onLogout: () => void;
}>) {
  return (
    <div className="flex flex-col gap-2 border-t border-white/8 pt-4">
      <div className="flex min-w-0 items-center gap-3 rounded-xl border border-white/8 bg-white/[0.035] p-2.5">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/10 font-heading text-sm font-bold text-primary shadow-glow-primary"
        >
          {accountInitials(user)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">
            {user.displayName}
          </p>
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
        </div>
      </div>
      <p className="truncate px-2 text-xs text-muted-foreground">
        {workspace.role} access
      </p>
      {logoutError === undefined ? null : (
        <p
          role="alert"
          className="px-2 text-xs leading-relaxed text-destructive"
        >
          {logoutError}
        </p>
      )}
      <Button
        type="button"
        variant="ghost"
        className="justify-start"
        onClick={onChangeWorkspace}
      >
        <PanelsTopLeftIcon data-icon="inline-start" aria-hidden="true" />
        Change workspace
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="justify-start"
        disabled={logoutPending}
        onClick={onLogout}
      >
        <LogOutIcon data-icon="inline-start" aria-hidden="true" />
        {logoutPending ? 'Signing out…' : 'Sign out'}
      </Button>
    </div>
  );
}

function accountInitials(user: UserProfileResponse): string {
  const nameParts = user.displayName.trim().split(/\s+/u).filter(Boolean);
  const initials = nameParts
    .slice(0, 2)
    .map((part) => part[0])
    .join('');
  if (initials.length > 0) return initials.toUpperCase();
  return (user.email[0] ?? 'P').toUpperCase();
}
