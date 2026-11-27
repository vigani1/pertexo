import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/class-names';

// Every empty state names its next action: compose Empty with a media slot
// (a status glyph or small Core), a title, a description and EmptyActions.
const emptyVariants = cva('flex flex-col items-start gap-2.5', {
  variants: {
    spacing: { page: 'py-7', flush: 'border-t-0 py-2' },
  },
  defaultVariants: { spacing: 'page' },
});

export function Empty({
  spacing,
  className,
  ...props
}: ComponentProps<'div'> & VariantProps<typeof emptyVariants>) {
  return (
    <div
      data-slot="empty"
      className={cn(emptyVariants({ spacing }), className)}
      {...props}
    />
  );
}

export function EmptyMedia({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty-media"
      className={cn('mb-1 text-subtle-foreground', className)}
      {...props}
    />
  );
}

const emptyTitleVariants = cva('font-heading font-semibold', {
  variants: {
    size: { section: 'text-section', panel: 'text-xl', feature: 'text-3xl' },
  },
  defaultVariants: { size: 'section' },
});

export function EmptyTitle({
  size,
  className,
  ...props
}: ComponentProps<'h2'> & VariantProps<typeof emptyTitleVariants>) {
  return (
    <h2
      data-slot="empty-title"
      className={cn(emptyTitleVariants({ size }), className)}
      {...props}
    />
  );
}

export function EmptyDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="empty-description"
      className={cn(
        'max-w-lg text-sm leading-relaxed text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function EmptyActions({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty-actions"
      className={cn('mt-2 flex flex-wrap items-center gap-2', className)}
      {...props}
    />
  );
}
