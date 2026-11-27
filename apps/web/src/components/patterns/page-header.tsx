import type { ComponentProps } from 'react';
import { cn } from '@/lib/class-names';

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

const HEADING_TAGS = { 1: 'h1', 2: 'h2' } as const;

/**
 * The page's title. Beside a detail that owns the page's title (list and
 * detail), the list's title steps down to a second-level heading.
 */
export function PageHeaderTitle({
  className,
  level = 1,
  ...props
}: ComponentProps<'h1'> & Readonly<{ level?: 1 | 2 }>) {
  const Heading = HEADING_TAGS[level];
  return (
    <Heading
      data-slot="page-header-title"
      className={cn(
        'font-display text-4xl leading-tight [--display-width:80%] sm:text-display',
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
