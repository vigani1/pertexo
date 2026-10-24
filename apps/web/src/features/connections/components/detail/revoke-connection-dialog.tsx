import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { isUnconfirmedCommand } from '@/lib/api/commands/contract';
import { useState } from 'react';
import type { ConnectionResponse } from '@pertexo/contracts';
import {
  ConfirmDialog,
  ConfirmationFooter,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { Button } from '@/components/ui/button';
import { useNotifications } from '@/components/ui/use-notifications';
import { connectionCommandError } from '../../model/connection-errors';
import {
  useRevokeConnectionMutation,
  type ConnectionMutationScope,
} from '../../data/connections.mutations';

/** Revoke lives here, behind a confirmation — never as a button in each row. */
export function RevokeConnectionDialog({
  scope,
  connection,
}: Readonly<{
  scope: ConnectionMutationScope;
  connection: ConnectionResponse;
}>) {
  const notifications = useNotifications();
  const [open, setOpen] = useState(false);
  const mutation = useRevokeConnectionMutation(scope);

  return (
    <ConfirmDialog
      state={{
        open: open,
        onOpenChange: (next) => {
          setOpen(next);
          if (!next) mutation.reset();
        },
        locked: mutation.isPending,
      }}
      title={`Revoke ${connection.name}?`}
      description="Steps and alerts that use it stop working from their next run. Past runs keep their history. A revoked connection can’t be turned back on — you would add a new one."
      trigger={
        <Button type="button" variant="destructive">
          Revoke
        </Button>
      }
      onSubmit={async () => {
        // Revoking re-renders the detail without this dialog, so the toast
        // follows the awaited command rather than a `mutate()` callback.
        await mutation.mutateAsync(connection.id);
        notifications.success({ title: `Revoked ${connection.name}` });
        setOpen(false);
        mutation.reset();
      }}
      submitDisabled={mutation.isPending}
      footer={
        <ConfirmationFooter>
          <DialogClose
            disabled={mutation.isPending}
            render={<Button type="button" variant="ghost" />}
          >
            Keep connection
          </DialogClose>
          <ProgressButton
            type="submit"
            variant="destructive"
            pending={mutation.isPending}
            pendingLabel="Revoking…"
          >
            Revoke connection
          </ProgressButton>
        </ConfirmationFooter>
      }
    >
      <ConfirmationDetails
        error={
          mutation.isError
            ? connectionCommandError(mutation.error, 'revoke', connection.name)
            : undefined
        }
        tone={
          mutation.isError && isUnconfirmedCommand(mutation.error)
            ? 'warning'
            : 'destructive'
        }
      />
    </ConfirmDialog>
  );
}
