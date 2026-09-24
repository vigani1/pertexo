import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// Every empty state names its next action: compose Empty with a media slot
// (a status glyph or small Core), a title, a description and EmptyActions.
export function Empty({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty"
      className={cn(
        'flex min-h-56 flex-col items-start justify-center gap-3 border-t border-border py-12',
        className,
      )}
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

export function EmptyTitle({ className, ...props }: ComponentProps<'h2'>) {
  return (
    <h2
      data-slot="empty-title"
      className={cn('text-2xl font-semibold', className)}
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
