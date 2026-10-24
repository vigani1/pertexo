import type { ComponentProps } from 'react';
import { RotateCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { CoreOrb } from '../core/orb';
import {
  SystemState,
  SystemStateActions,
  SystemStateArt,
  SystemStateDescription,
  SystemStateTitle,
} from '../states/system';

// The person decides when to reload. A page with unsaved work keeps its
// beforeunload guard, so the browser asks before that work is dropped.
function reload() {
  window.location.reload();
}

function ReloadButton(
  props: Readonly<Pick<ComponentProps<typeof Button>, 'variant' | 'size'>>,
) {
  return (
    <Button type="button" {...props} onClick={reload}>
      <RotateCwIcon aria-hidden="true" data-icon="inline-start" />
      Reload
    </Button>
  );
}

/** In place of a piece of a page; the rest of the page stays as it is. */
export function AppUpdatedNotice() {
  return (
    <Notice action={<ReloadButton variant="outline" size="sm" />}>
      Pertexo was updated. Reload to continue.
    </Notice>
  );
}

/** In place of a dialog that couldn't load. */
export function AppUpdatedDialog({
  onClose,
  finalFocus,
}: Readonly<{
  onClose: () => void;
  finalFocus?: ComponentProps<typeof DialogContent>['finalFocus'];
}>) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent finalFocus={finalFocus}>
        <DialogTitle>Pertexo was updated</DialogTitle>
        <DialogDescription>Reload to continue.</DialogDescription>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
          <ReloadButton variant="primary" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** In place of a route's page, inside whatever shell surrounds it. */
export function AppUpdatedPage() {
  return (
    <div className="grid min-h-[60svh] place-items-center px-5">
      <SystemState role="status" className="items-center text-center">
        <SystemStateArt>
          <CoreOrb state="idle" className="size-36" />
        </SystemStateArt>
        <SystemStateTitle>Pertexo was updated</SystemStateTitle>
        <SystemStateDescription>Reload to continue.</SystemStateDescription>
        <SystemStateActions>
          <ReloadButton variant="primary" />
        </SystemStateActions>
      </SystemState>
    </div>
  );
}
