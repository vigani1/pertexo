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
import { RingMonogram } from './workspace-mark';

export function AccountMenu({
  user,
  workspaceId,
  logoutPending,
  onLogout,
}: Readonly<{
  user: UserProfileResponse;
  workspaceId: string;
  logoutPending: boolean;
  onLogout: () => void;
}>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account menu for ${user.displayName}`}
        className="mt-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <RingMonogram name={user.displayName || user.email} />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="normal-case">
            <span className="block truncate font-sans text-sm font-semibold tracking-normal text-foreground">
              {user.displayName}
            </span>
            <span className="block truncate font-sans text-xs tracking-normal">
              {user.email}
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem
          render={
            <Link to="/w/$workspaceId/account" params={{ workspaceId }} />
          }
        >
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
  );
}
