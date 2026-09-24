import { useState } from 'react';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { Button } from '@/components/ui/button';
import { useNotifications } from '@/components/ui/use-notifications';
import { isUncertainOutcome } from '@/lib/api/api-error-copy';
import { connectionCommandError } from '../../connection-errors';
import {
  useRevokeConnectionMutation,
  type ConnectionMutationScope,
} from '../../connections.mutations';

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
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) mutation.reset();
      }}
      trigger={
        <Button type="button" variant="destructive">
          Revoke
        </Button>
      }
      title={`Revoke ${connection.name}?`}
      description="Steps and alerts that use it stop working from their next run. Past runs keep their history. A revoked connection can’t be turned back on — you would add a new one."
      tone="destructive"
      confirmLabel="Revoke connection"
      pendingLabel="Revoking…"
      cancelLabel="Keep connection"
      pending={mutation.isPending}
      error={
        mutation.isError
          ? connectionCommandError(mutation.error, 'revoke', connection.name)
          : undefined
      }
      errorTone={
        mutation.isError && isUncertainOutcome(mutation.error)
          ? 'warning'
          : 'destructive'
      }
      onConfirm={async () => {
        // Revoking re-renders the detail without this dialog, so the toast
        // follows the awaited command rather than a `mutate()` callback.
        await mutation.mutateAsync(connection.id);
        notifications.success({ title: `Revoked ${connection.name}` });
        setOpen(false);
        mutation.reset();
      }}
    />
  );
}
