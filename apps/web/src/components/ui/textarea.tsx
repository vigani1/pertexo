import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'recessed-control min-h-24 w-full min-w-0 resize-y rounded-md border px-3 py-2 text-base md:text-sm',
        className,
      )}
      {...props}
    />
  );
}
