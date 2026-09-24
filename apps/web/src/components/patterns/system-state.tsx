import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// Full-screen or in-shell state for missing, forbidden and failed screens.
// Compose: SystemState > SystemStateArt, SystemStateTitle,
// SystemStateDescription, SystemStateActions.
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
        'mb-2 grid h-28 w-full max-w-60 place-items-center rounded-lg bg-black/25',
        className,
      )}
      {...props}
    />
  );
}

export function SystemStateTitle({
  className,
  ...props
}: ComponentProps<'h1'>) {
  return (
    <h1
      data-slot="system-state-title"
      className={cn('text-4xl leading-none font-semibold', className)}
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
      className={cn('leading-relaxed text-muted-foreground', className)}
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
