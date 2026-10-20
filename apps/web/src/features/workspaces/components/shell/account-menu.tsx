import type { UserProfileResponse } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { LogOutIcon, ShieldCheckIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { setAppearance, useAppearance } from '@/lib/appearance/use-choice';
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
  const appearance = useAppearance();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account menu for ${user.displayName}`}
        className="mt-1 rounded-full outline-none focus-ring"
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
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            aria-label="Theme"
            value={appearance.preference}
            onValueChange={(value: unknown) => {
              if (value === 'system' || value === 'light' || value === 'dark')
                setAppearance(value);
            }}
          >
            <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
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
