import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import { Button } from '@/components/ui/button';
import type { LeaveReason } from '../../hooks/use-leave-guard';

type Blocker =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'blocked'; proceed: () => void; reset: () => void }>;

const leaveCopy: Readonly<
  Record<LeaveReason, Readonly<{ title: string; description: string }>>
> = {
  unsaved: {
    title: 'Leave with unsaved changes?',
    description:
      'Your latest changes haven’t reached the server yet. Save them first, or leave and lose them.',
  },
  unfinished: {
    title: 'Leave with an unfinished edit?',
    description:
      'An editor field hasn’t been applied yet. Leaving discards it.',
  },
};

/** Router navigation guard: stay, save and leave, or leave anyway. */
export function LeaveEditorDialog({
  blocker,
  reason,
  saving,
  onSaveAndLeave,
}: Readonly<{
  blocker: Blocker;
  reason: LeaveReason;
  saving: boolean;
  onSaveAndLeave: () => void;
}>) {
  const copy = leaveCopy[reason];
  const canSave = reason === 'unsaved';
  const leave = () => {
    if (blocker.status === 'blocked') blocker.proceed();
  };
  return (
    <ConfirmDialog
      state={{
        open: blocker.status === 'blocked',
        onOpenChange: (open) => {
          if (!open && blocker.status === 'blocked') blocker.reset();
        },
        locked: saving,
      }}
      title={copy.title}
      description={copy.description}
      onSubmit={canSave ? onSaveAndLeave : leave}
      submitDisabled={saving}
      actions={{
        cancel: {
          kind: 'close',
          label: 'Stay here',
          disabled: saving,
          variant: 'ghost',
        },
        secondaryAction: canSave ? (
          <Button
            type="button"
            variant="destructive"
            disabled={saving}
            onClick={leave}
          >
            Leave anyway
          </Button>
        ) : undefined,
        confirm: {
          label: canSave ? 'Save and leave' : 'Leave anyway',
          variant: canSave ? 'primary' : 'destructive',
          pending: saving,
          pendingLabel: 'Saving…',
        },
      }}
    ></ConfirmDialog>
  );
}

/** An in-page command would replace an edit that isn't valid yet. */
export function UnfinishedEditDialog({
  open,
  onDiscard,
  onStay,
}: Readonly<{ open: boolean; onDiscard: () => void; onStay: () => void }>) {
  return (
    <ConfirmDialog
      state={{
        open: open,
        onOpenChange: (next) => {
          if (!next) onStay();
        },
        locked: false,
      }}
      title="Discard the unfinished edit?"
      description="A field in the step panel isn’t valid yet, so it hasn’t been saved. Stay to fix it, or discard it and continue."
      onSubmit={onDiscard}
      actions={{
        cancel: { kind: 'close', label: 'Stay', variant: 'ghost' },
        confirm: {
          label: 'Discard edit',
          type: 'submit',
          variant: 'destructive',
          pendingLabel: 'Discard edit',
        },
      }}
    ></ConfirmDialog>
  );
}
