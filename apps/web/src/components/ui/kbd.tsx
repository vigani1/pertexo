import type { ComponentProps } from 'react';
import { cn } from '@/lib/class-names';

export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-border bg-select-raised px-1 font-mono text-micro leading-none text-muted-foreground select-none in-data-[variant=primary]:border-primary-foreground/30 in-data-[variant=primary]:text-primary-foreground/70',
        className,
      )}
      {...props}
    />
  );
}
