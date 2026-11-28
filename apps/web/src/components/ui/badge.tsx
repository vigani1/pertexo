import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/class-names';

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center gap-1 min-h-6.5 rounded-sm border border-border bg-select-raised px-2 text-meta font-medium text-foreground',
  {
    variants: {
      variant: {
        default: '',
        secondary: '',
        muted: 'text-muted-foreground',
        strong: 'font-semibold',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}
