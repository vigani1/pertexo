import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// The one page-header composition: a display title, a mono status line of
// live facts, and actions on the right. Named slots; no context needed.
export function PageHeader({ className, ...props }: ComponentProps<'header'>) {
  return (
    <header
      data-slot="page-header"
      className={cn(
        'flex flex-wrap items-end justify-between gap-x-6 gap-y-4',
        className,
      )}
      {...props}
    />
  );
}

export function PageHeaderTitle({ className, ...props }: ComponentProps<'h1'>) {
  return (
    <h1
      data-slot="page-header-title"
      className={cn(
        'text-4xl leading-[0.95] font-semibold tracking-[-0.035em] sm:text-[2.75rem]',
        className,
      )}
      {...props}
    />
  );
}

export function PageHeaderMeta({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="page-header-meta"
      className={cn(
        'mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-xs text-subtle-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function PageHeaderActions({
  className,
  ...props
}: ComponentProps<'div'>) {
  return (
    <div
      data-slot="page-header-actions"
      className={cn('flex flex-wrap items-center gap-2', className)}
      {...props}
    />
  );
}
