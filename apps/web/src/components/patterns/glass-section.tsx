import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function GlassSection({
  className,
  ...props
}: ComponentProps<'section'>) {
  return (
    <section
      data-slot="glass-section"
      className={cn(
        'glass-panel min-w-0 rounded-xl text-card-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function GlassSectionHeader({
  className,
  ...props
}: ComponentProps<'div'>) {
  return (
    <div
      data-slot="glass-section-header"
      className={cn('flex flex-col gap-2 border-b px-6 py-5', className)}
      {...props}
    />
  );
}

export function GlassSectionTitle({
  className,
  ...props
}: ComponentProps<'h2'>) {
  return (
    <h2
      data-slot="glass-section-title"
      className={cn('text-xl font-semibold tracking-tight', className)}
      {...props}
    />
  );
}

export function GlassSectionDescription({
  className,
  ...props
}: ComponentProps<'p'>) {
  return (
    <p
      data-slot="glass-section-description"
      className={cn('text-sm leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
}

export function GlassSectionContent({
  className,
  ...props
}: ComponentProps<'div'>) {
  return (
    <div
      data-slot="glass-section-content"
      className={cn('p-6', className)}
      {...props}
    />
  );
}
