import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/class-names';

// Full-screen or in-shell state for missing, forbidden and failed screens.
// Compose: SystemState > SystemStateArt, SystemStateTitle,
// SystemStateDescription, SystemStateActions. In the shell it reads from
// the left like the page around it; a full screen centres it.
export function SystemState({
  className,
  ...props
}: ComponentProps<'section'>) {
  return (
    <section
      data-slot="system-state"
      className={cn(
        'mx-auto flex w-full max-w-lg flex-col items-start gap-4 py-16',
        className,
      )}
      {...props}
    />
  );
}

export function SystemStateArt({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="system-state-art"
      className={cn(
        // The art sits on the page itself, never in a frame of its own.
        'mb-1 flex min-h-24 items-center',
        className,
      )}
      {...props}
    />
  );
}

const systemStateTitle = cva('font-display text-4xl leading-none', {
  variants: { size: { hero: 'sm:text-hero' } },
});

export function SystemStateTitle({
  className,
  size,
  ...props
}: ComponentProps<'h1'> & VariantProps<typeof systemStateTitle>) {
  return (
    <h1
      data-slot="system-state-title"
      className={cn(systemStateTitle({ size }), className)}
      {...props}
    />
  );
}

export function SystemStateDescription({
  className,
  ...props
}: ComponentProps<'p'>) {
  return (
    <p
      data-slot="system-state-description"
      className={cn(
        'leading-relaxed text-pretty text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function SystemStateActions({
  className,
  ...props
}: ComponentProps<'div'>) {
  return (
    <div
      data-slot="system-state-actions"
      className={cn('mt-2 flex flex-wrap items-center gap-2', className)}
      {...props}
    />
  );
}
