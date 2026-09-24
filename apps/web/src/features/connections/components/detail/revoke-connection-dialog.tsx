import { useState } from 'react';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Notice } from '@/components/ui/notice';
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

  function changeOpen(next: boolean) {
    if (mutation.isPending) return;
    setOpen(next);
    if (!next) mutation.reset();
  }

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        onClick={() => {
          setOpen(true);
        }}
      >
        Revoke
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent>
          <DialogTitle>Revoke {connection.name}?</DialogTitle>
          <DialogDescription>
            Steps and alerts that use it stop working from their next run. Past
            runs keep their history. A revoked connection can’t be turned back
            on — you would add a new one.
          </DialogDescription>
          {mutation.isError ? (
            <Notice
              role="alert"
              className="mt-5"
              tone={
                isUncertainOutcome(mutation.error) ? 'warning' : 'destructive'
              }
            >
              {connectionCommandError(
                mutation.error,
                'revoke',
                connection.name,
              )}
            </Notice>
          ) : null}
          <div className="mt-7 flex justify-end gap-2">
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  disabled={mutation.isPending}
                />
              }
            >
              Keep connection
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() => {
                mutation.mutate(connection.id, {
                  onSuccess: () => {
                    notifications.success({
                      title: `Revoked ${connection.name}`,
                    });
                    setOpen(false);
                    mutation.reset();
                  },
                });
              }}
            >
              {mutation.isPending ? (
                <LoadingOrb data-icon="inline-start" />
              ) : null}
              {mutation.isPending ? 'Revoking…' : 'Revoke connection'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
