import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/class-names';

/**
 * One line of a list: hairlines between rows, never boxes. Hover lifts the
 * background; the selected row lifts it further. The grid columns are the
 * caller's layout, passed in `className`.
 */
const rowVariants = cva(
  'row-divider grid min-w-0 items-center gap-x-4 gap-y-1 rounded-lg px-3.5 py-3 transition-colors duration-(--duration-quick)',
  {
    variants: {
      lift: {
        none: '',
        hover: 'hover:bg-select focus-within:bg-select',
      },
      selected: {
        true: 'bg-select-raised hover:bg-select-raised',
        false: '',
      },
    },
    defaultVariants: { lift: 'hover', selected: false },
  },
);

export function RowList({ className, ...props }: ComponentProps<'ul'>) {
  // The negative margin lines row text up with the page; the lift overhangs.
  return (
    <ul className={cn('-mx-3.5 flex min-w-0 flex-col', className)} {...props} />
  );
}

export function Row({
  className,
  lift,
  selected,
  ...props
}: ComponentProps<'li'> & VariantProps<typeof rowVariants>) {
  return (
    <li className={cn(rowVariants({ lift, selected }), className)} {...props} />
  );
}
