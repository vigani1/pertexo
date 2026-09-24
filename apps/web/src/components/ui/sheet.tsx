import type { ComponentProps } from 'react';
import { Dialog as SheetPrimitive } from '@base-ui/react/dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonVariants } from './button-variants';

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;

const sheetContentVariants = cva(
  'lens fixed z-50 flex flex-col text-sm text-popover-foreground outline-none transition-[transform,opacity] duration-300 ease-unspool data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none',
  {
    variants: {
      side: {
        right:
          'inset-y-3 right-3 w-[min(26rem,calc(100vw-1.5rem))] rounded-xl data-ending-style:translate-x-8 data-starting-style:translate-x-8',
        left: 'inset-y-3 left-3 w-[min(21rem,calc(100vw-1.5rem))] rounded-xl data-ending-style:-translate-x-8 data-starting-style:-translate-x-8',
        bottom:
          'inset-x-2 bottom-2 max-h-[85svh] rounded-xl data-ending-style:translate-y-8 data-starting-style:translate-y-8',
      },
    },
    defaultVariants: { side: 'right' },
  },
);

/** A floating lens that slides in from an edge: inspectors, forms, menus. */
export function SheetContent({
  className,
  children,
  side,
  ...props
}: SheetPrimitive.Popup.Props & VariantProps<typeof sheetContentVariants>) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] transition-opacity duration-300 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        className={cn(sheetContentVariants({ side }), className)}
        {...props}
      >
        {children}
        <SheetPrimitive.Close
          aria-label="Close"
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
            'absolute top-4 right-4',
          )}
        >
          <XIcon aria-hidden="true" />
        </SheetPrimitive.Close>
      </SheetPrimitive.Popup>
    </SheetPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col gap-1 px-5 pt-5 pr-14 pb-4', className)}
      {...props}
    />
  );
}

export function SheetBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-body"
      className={cn('min-h-0 flex-1 overflow-y-auto px-5 pb-5', className)}
      {...props}
    />
  );
}

export function SheetFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        'flex items-center justify-end gap-2 border-t border-border px-5 py-4',
        className,
      )}
      {...props}
    />
  );
}

export function SheetTitle({
  className,
  ...props
}: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('font-heading text-xl font-semibold', className)}
      {...props}
    />
  );
}

export function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-muted-foreground', className)}
      {...props}
    />
  );
}
