import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { Link } from '@tanstack/react-router';
import { LogOutIcon } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { canLeaveWorkspace } from '../../model/workspace-roles';
import { useLeaveWorkspaceCommand } from '../../mutations/use-leave-workspace-command';

/**
 * Leave the workspace (ADR 047). The owner can't: they are told to make
 * another member the owner first. Everyone else confirms the consequences,
 * then goes back to their workspaces.
 */
export function WorkspaceLeave({
  apiClient,
  workspace,
  onLeft,
}: Readonly<{
  apiClient: ApiClient;
  workspace: AccessibleWorkspace;
  onLeft: () => void;
}>) {
  const notifications = useNotifications();
  const [confirming, setConfirming] = useState(false);
  const command = useLeaveWorkspaceCommand({
    apiClient,
    workspaceId: workspace.id,
    onLeft: (confirmed) => {
      if (confirmed)
        notifications.success({
          title: `You left ${workspace.name}`,
          description: 'Sign in again to reach your other workspaces.',
        });
      onLeft();
    },
  });
  const isOwner = !canLeaveWorkspace(workspace.role);

  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="max-w-xl">
        <p className="text-sm font-semibold">Leave workspace</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {isOwner
            ? 'You’re the owner, so you can’t leave yet. Make another member the owner from Team, then leave.'
            : 'Your access ends straight away. To come back, someone has to invite you again.'}
        </p>
      </div>
      {isOwner ? (
        <Link
          to="/w/$workspaceId/team"
          params={{ workspaceId: workspace.id }}
          className={buttonVariants({ variant: 'outline' })}
        >
          Go to Team
        </Link>
      ) : (
        <Button
          type="button"
          variant="destructive"
          onClick={() => {
            setConfirming(true);
          }}
        >
          <LogOutIcon data-icon="inline-start" aria-hidden="true" />
          Leave workspace
        </Button>
      )}
      <ConfirmDialog
        open={confirming && !isOwner}
        onOpenChange={setConfirming}
        locked={command.pending || command.retryAvailable}
        tone="destructive"
        title={`Leave ${workspace.name}?`}
        consequences={[
          'You lose access to its workflows, runs and connections straight away.',
          'You’re signed out everywhere, including here, and sign in again to reach your other workspaces.',
          'Runs you already started keep going, and invitations you sent stay pending.',
          'To come back, an owner or admin has to invite you again.',
        ]}
        confirmLabel="Leave workspace"
        pendingLabel="Leaving…"
        pending={command.pending}
        error={command.error}
        onConfirm={() => command.start()}
        unconfirmed={
          command.retryAvailable
            ? { onRetry: () => command.retry(), onDismiss: command.dismiss }
            : undefined
        }
      />
    </div>
  );
}
