import { useState } from 'react';
import {
  ConfirmDialog,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { Button } from '@/components/ui/button';
/** Confirms a change that brings the workspace back and says what stays off. */
export function WorkspaceLifecycleDialog({
  title,
  description,
  action,
  pendingLabel,
  pending,
  error,
  onConfirm,
}: Readonly<{
  title: string;
  description: string;
  action: string;
  pendingLabel: string;
  pending: boolean;
  error: string | undefined;
  onConfirm: () => Promise<boolean>;
}>) {
  const [open, setOpen] = useState(false);
  async function send(command: () => Promise<boolean>) {
    if (await command()) setOpen(false);
  }
  return (
    <ConfirmDialog
      state={{
        open: open,
        onOpenChange: setOpen,
        locked: pending,
      }}
      title={title}
      description={description}
      trigger={
        <Button type="button" variant="default">
          {action}
        </Button>
      }
      onSubmit={() => send(onConfirm)}
      submitDisabled={pending}
      actions={{
        cancel: {
          kind: 'close',
          label: 'Cancel',
          variant: 'ghost',
          disabled: pending,
        },
        confirm: {
          label: action,
          type: 'submit',
          variant: 'primary',
          pending: pending,
          pendingLabel: pendingLabel,
        },
      }}
    >
      <ConfirmationDetails error={error} tone="destructive" />
    </ConfirmDialog>
  );
}
