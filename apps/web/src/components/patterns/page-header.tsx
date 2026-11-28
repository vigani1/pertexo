import { cva, type VariantProps } from 'class-variance-authority';
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

const titleVariants = cva('leading-tight', {
  variants: {
    size: {
      page: 'font-display text-4xl [--display-width:80%] sm:text-display',
      hero: 'font-display text-4xl [--display-width:80%] sm:text-5xl',
      section: 'font-heading text-section font-semibold',
      detail: 'font-display text-3xl [--display-width:78%] sm:text-display',
    },
  },
  defaultVariants: { size: 'page' },
});

/**
 * The page's title. Beside a detail that owns the page's title (list and
 * detail), the list's title steps down to a second-level heading.
 */
export function PageHeaderTitle({
  className,
  level = 1,
  size,
  ...props
}: ComponentProps<'h1'> &
  VariantProps<typeof titleVariants> &
  Readonly<{ level?: 1 | 2 }>) {
  const Heading = HEADING_TAGS[level];
  return (
    <Heading
      data-slot="page-header-title"
      className={cn(titleVariants({ size }), className)}
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
