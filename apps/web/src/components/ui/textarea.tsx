import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/class-names';

const textareaVariants = cva(
  'recessed-control min-h-22 w-full min-w-0 resize-y rounded-md border px-3 py-2.5 text-base sm:text-sm',
  {
    variants: {
      typography: {
        mono: 'font-mono',
        code: 'font-mono md:text-label',
        'compact-code': 'font-mono md:text-xs',
      },
      emphasis: {
        active: 'border-primary/30',
      },
    },
  },
);

export function Textarea({
  className,
  typography,
  emphasis,
  ...props
}: ComponentProps<'textarea'> & VariantProps<typeof textareaVariants>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(textareaVariants({ typography, emphasis }), className)}
      {...props}
    />
  );
}
