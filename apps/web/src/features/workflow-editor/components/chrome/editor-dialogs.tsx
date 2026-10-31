import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import {
  ConfirmDialog,
  ConfirmationFooter,
} from '@/components/patterns/actions/confirm-dialog';
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
      footer={
        <ConfirmationFooter>
          <DialogClose
            disabled={saving}
            render={<Button type="button" variant="ghost" />}
          >
            Stay here
          </DialogClose>
          {canSave ? (
            <Button
              type="button"
              variant="destructive"
              disabled={saving}
              onClick={leave}
            >
              {'Leave anyway'}
            </Button>
          ) : undefined}
          <ProgressButton
            type="submit"
            variant={
              (canSave ? 'default' : 'destructive') === 'destructive'
                ? 'destructive'
                : 'primary'
            }
            pending={saving}
            pendingLabel="Saving…"
          >
            {canSave ? 'Save and leave' : 'Leave anyway'}
          </ProgressButton>
        </ConfirmationFooter>
      }
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
      footer={
        <ConfirmationFooter>
          <DialogClose render={<Button type="button" variant="ghost" />}>
            Stay
          </DialogClose>
          <ProgressButton
            type="submit"
            variant="destructive"
            pendingLabel="Discard edit"
          >
            Discard edit
          </ProgressButton>
        </ConfirmationFooter>
      }
    ></ConfirmDialog>
  );
}
