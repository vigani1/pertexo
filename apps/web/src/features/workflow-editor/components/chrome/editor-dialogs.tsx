import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { Button } from '@/components/ui/button';
import type { LeaveReason } from '../../model/use-leave-guard';

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
      'A field in the step panel isn’t valid yet, so it hasn’t been saved. Leaving discards it.',
  },
  comparison: {
    title: 'Discard your kept copy?',
    description:
      'Your copy from the conflict is only kept in this tab. Leaving now discards it.',
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
  const leaveLabel =
    reason === 'comparison' ? 'Discard and leave' : 'Leave anyway';
  const leave = () => {
    if (blocker.status === 'blocked') blocker.proceed();
  };
  return (
    <ConfirmDialog
      open={blocker.status === 'blocked'}
      onOpenChange={(open) => {
        if (!open && blocker.status === 'blocked') blocker.reset();
      }}
      title={copy.title}
      description={copy.description}
      cancelLabel="Stay here"
      tone={canSave ? 'default' : 'destructive'}
      confirmLabel={canSave ? 'Save and leave' : leaveLabel}
      pendingLabel="Saving…"
      pending={saving}
      onConfirm={canSave ? onSaveAndLeave : leave}
      secondaryAction={
        canSave ? (
          <Button
            type="button"
            variant="destructive"
            disabled={saving}
            onClick={leave}
          >
            {leaveLabel}
          </Button>
        ) : undefined
      }
    />
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
      open={open}
      onOpenChange={(next) => {
        if (!next) onStay();
      }}
      title="Discard the unfinished edit?"
      description="A field in the step panel isn’t valid yet, so it hasn’t been saved. Stay to fix it, or discard it and continue."
      tone="destructive"
      confirmLabel="Discard edit"
      cancelLabel="Stay"
      onConfirm={onDiscard}
    />
  );
}
