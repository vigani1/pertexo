import type { ComponentProps } from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogClose = DialogPrimitive.Close;
export const DialogTrigger = DialogPrimitive.Trigger;

const dialogViewportVariants = cva(
  'fixed inset-0 z-50 flex overflow-y-auto overscroll-contain',
  {
    variants: {
      placement: {
        center: 'items-center justify-center p-4',
        left: 'items-stretch justify-start p-0',
      },
    },
    defaultVariants: { placement: 'center' },
  },
);

const dialogContentVariants = cva(
  'lens relative w-full overflow-y-auto shadow-2xl outline-none transition-[transform,opacity] motion-reduce:transition-none',
  {
    variants: {
      placement: {
        center:
          'max-h-[calc(100svh-2rem)] max-w-lg rounded-xl p-6 ease-unspool data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
        left: 'h-svh max-w-[min(21rem,88vw)] border-y-0 border-l-0 p-0 data-[ending-style]:-translate-x-full data-[ending-style]:opacity-0 data-[starting-style]:-translate-x-full data-[starting-style]:opacity-0',
      },
    },
    defaultVariants: { placement: 'center' },
  },
);

export function DialogContent({
  className,
  placement = 'center',
  ...props
}: ComponentProps<typeof DialogPrimitive.Popup> &
  VariantProps<typeof dialogContentVariants>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
      <DialogPrimitive.Viewport
        className={dialogViewportVariants({ placement })}
      >
        <DialogPrimitive.Popup
          className={cn(dialogContentVariants({ placement }), className)}
          {...props}
        />
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-xl font-semibold', className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn(
        'mt-2 text-sm leading-relaxed text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
