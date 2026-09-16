import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Empty({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty"
      className={cn(
        'flex min-h-64 flex-col items-start justify-center border-y border-border px-1 py-14',
        className,
      )}
      {...props}
    />
  );
}

export function EmptyTitle({ className, ...props }: ComponentProps<'h2'>) {
  return (
    <h2
      data-slot="empty-title"
      className={cn('text-2xl font-semibold tracking-tight', className)}
      {...props}
    />
  );
}

export function EmptyDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="empty-description"
      className={cn(
        'mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
