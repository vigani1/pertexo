import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useRouter } from '@tanstack/react-router';
import { MenuIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { WorkspaceSidebarContent } from './workspace-sidebar-content';

export function MobileWorkspaceNavigation({
  user,
  workspace,
  logoutPending,
  logoutError,
  onChangeWorkspace,
  onLogout,
  triggerVisibility = 'mobile',
}: Readonly<{
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  logoutPending: boolean;
  logoutError?: string;
  onChangeWorkspace: () => void;
  onLogout: () => void;
  triggerVisibility?: 'mobile' | 'always';
}>) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    return router.subscribe('onResolved', (event) => {
      if (event.hrefChanged) setOpen(false);
    });
  }, [open, router]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            aria-label="Open navigation"
            className={triggerVisibility === 'mobile' ? 'lg:hidden' : undefined}
          />
        }
      >
        <MenuIcon aria-hidden="true" />
      </DialogTrigger>
      <DialogContent placement="left">
        <DialogTitle className="sr-only">Workspace navigation</DialogTitle>
        <DialogDescription className="sr-only">
          Navigate within the current workspace or manage your session.
        </DialogDescription>
        <DialogClose
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label="Close navigation"
              className="absolute top-3 right-3"
            />
          }
        >
          <XIcon aria-hidden="true" />
        </DialogClose>
        <WorkspaceSidebarContent
          user={user}
          workspace={workspace}
          logoutPending={logoutPending}
          {...(logoutError === undefined ? {} : { logoutError })}
          onChangeWorkspace={onChangeWorkspace}
          onLogout={onLogout}
        />
      </DialogContent>
    </Dialog>
  );
}
