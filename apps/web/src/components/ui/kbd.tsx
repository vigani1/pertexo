import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-white/14 px-1 font-mono text-[0.68rem] leading-none text-subtle-foreground select-none in-data-[variant=primary]:border-primary-foreground/30 in-data-[variant=primary]:text-primary-foreground/70',
        className,
      )}
      {...props}
    />
  );
}
