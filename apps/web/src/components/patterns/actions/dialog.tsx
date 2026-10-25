import type { ReactNode } from 'react';
import { XIcon } from 'lucide-react';
import {
  Dialog,
  DialogFooter,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A dialog for one action: title and close at the top, the form in the
 * middle, its buttons at the bottom. While the action is in flight the dialog
 * can't be dismissed, so its outcome has one place to appear.
 */
export function ActionDialog({
  title,
  description,
  locked,
  onClose,
  footer,
  className,
  children,
}: Readonly<{
  title: string;
  description: ReactNode;
  locked: boolean;
  onClose: () => void;
  footer: ReactNode;
  className?: string;
  children: ReactNode;
}>) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
    >
      <DialogContent className={cn('flex flex-col gap-5', className)}>
        <div className="min-w-0 pr-8">
          <DialogTitle className="wrap-anywhere">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </div>
        {children}
        <DialogFooter>{footer}</DialogFooter>
        {/* Last in order, so opening focuses the first field, not Close. */}
        <DialogClose
          disabled={locked}
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close"
              className="absolute top-4 right-4"
            />
          }
        >
          <XIcon aria-hidden="true" />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
