import { SheetFooter } from '@/components/ui/sheet';
import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';

/** Permission changes unmount the owner of private files and reviewed graphs. */
export function PortabilityAccessDeniedDialog({
  operation,
  open = true,
  onClose,
  finalFocus,
}: Readonly<{
  operation: 'import' | 'export';
  open?: boolean;
  onClose: () => void;
  finalFocus?: ComponentProps<typeof SheetContent>['finalFocus'];
}>) {
  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <SheetContent variant="form" finalFocus={finalFocus}>
        <SheetTitle>
          {operation === 'import' ? 'Import workflow' : 'Export workflow'}
        </SheetTitle>
        <SheetDescription>
          {operation === 'import'
            ? 'Access changed. The file, preview and retained command have been cleared.'
            : 'Access changed. The reviewed source has been cleared.'}
        </SheetDescription>
        <SheetFooter className="mt-5">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
