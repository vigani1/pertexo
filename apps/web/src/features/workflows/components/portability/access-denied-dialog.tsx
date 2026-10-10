import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

/** Permission changes unmount the owner of private files and reviewed graphs. */
export function PortabilityAccessDeniedDialog({
  operation,
  open = true,
  onClose,
}: Readonly<{
  operation: 'import' | 'export';
  open?: boolean;
  onClose: () => void;
}>) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>
          {operation === 'import' ? 'Import workflow' : 'Export workflow'}
        </DialogTitle>
        <DialogDescription>
          {operation === 'import'
            ? 'Access changed. The file, preview and retained command have been cleared.'
            : 'Access changed. The reviewed source has been cleared.'}
        </DialogDescription>
        <div className="mt-5 flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
