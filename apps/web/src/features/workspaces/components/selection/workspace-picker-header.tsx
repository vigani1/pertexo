import type { UserProfileResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { Link } from '@tanstack/react-router';
import { LogOutIcon, ShieldCheckIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Wordmark } from '@/features/auth/auth-stage.public';
import { RingMonogram } from '../shell/workspace-mark';

/** The picker's header: the wordmark and the account menu. */
export function WorkspacePickerHeader({
  user,
  logoutPending,
  onLogout,
}: Readonly<{
  user: UserProfileResponse;
  logoutPending: boolean;
  onLogout: () => void;
}>) {
  return (
    <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 pt-6 sm:px-8">
      <Wordmark className="text-[1.375rem]" />
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Account menu for ${user.displayName}`}
          className="flex min-w-0 items-center gap-2.5 rounded-full py-1 pr-1 pl-1 text-sm text-muted-foreground outline-none hover:bg-white/5 hover:text-foreground focus-ring sm:pr-3"
        >
          <RingMonogram name={user.displayName || user.email} />
          <span className="max-w-48 truncate max-sm:hidden">{user.email}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex min-w-0 flex-col gap-0.5 font-sans tracking-normal normal-case">
              <span className="truncate text-sm font-semibold text-foreground">
                {user.displayName}
              </span>
              <span className="truncate text-xs">
                Signed in as {user.email}
              </span>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLinkItem render={<Link to="/account/security" />}>
            <ShieldCheckIcon aria-hidden="true" />
            Account &amp; security
          </DropdownMenuLinkItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={logoutPending}
            onClick={onLogout}
          >
            <LogOutIcon aria-hidden="true" />
            {logoutPending ? 'Signing out…' : 'Sign out'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
