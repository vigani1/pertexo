import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { LoadingOrb } from '@/components/ui/loading-orb';
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
  return (
    <Dialog
      open={blocker.status === 'blocked'}
      onOpenChange={(open) => {
        if (!open && blocker.status === 'blocked' && !saving) blocker.reset();
      }}
    >
      <DialogContent>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
        {blocker.status === 'blocked' ? (
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={blocker.reset}
            >
              Stay here
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={saving}
              onClick={blocker.proceed}
            >
              {reason === 'comparison' ? 'Discard and leave' : 'Leave anyway'}
            </Button>
            {reason === 'unsaved' ? (
              <Button type="button" disabled={saving} onClick={onSaveAndLeave}>
                {saving ? <LoadingOrb /> : null}
                {saving ? 'Saving…' : 'Save and leave'}
              </Button>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** An in-page command would replace an edit that isn't valid yet. */
export function UnfinishedEditDialog({
  open,
  onDiscard,
  onStay,
}: Readonly<{ open: boolean; onDiscard: () => void; onStay: () => void }>) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onStay();
      }}
    >
      <DialogContent>
        <DialogTitle>Discard the unfinished edit?</DialogTitle>
        <DialogDescription>
          A field in the step panel isn’t valid yet, so it hasn’t been saved.
          Stay to fix it, or discard it and continue.
        </DialogDescription>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onStay}>
            Stay
          </Button>
          <Button type="button" variant="destructive" onClick={onDiscard}>
            Discard edit
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
