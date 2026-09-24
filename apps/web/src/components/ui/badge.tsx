import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[0.72rem] font-medium',
  {
    variants: {
      variant: {
        default: 'border-primary/25 bg-primary/10 text-accent-foreground',
        secondary: 'border-secondary/25 bg-secondary/10 text-secondary',
        muted: 'border-border bg-white/[0.035] text-muted-foreground',
        success: 'border-success/30 bg-success/8 text-success',
        warning: 'border-warning/30 bg-warning/8 text-warning',
        destructive: 'border-destructive/30 bg-destructive/10 text-destructive',
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
