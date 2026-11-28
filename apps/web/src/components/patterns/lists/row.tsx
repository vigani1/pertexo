import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/class-names';

/**
 * One line of a list: hairlines between rows, never boxes. Hover lifts the
 * background; the selected row lifts it further. The grid columns are the
 * caller's layout, passed in `className`.
 */
const rowVariants = cva('row-divider', {
  variants: {
    lift: {
      none: '',
      pointer: 'hover:bg-select',
      hover: 'hover:bg-select focus-within:bg-select',
    },
    selected: {
      true: 'bg-select-raised',
      false: '',
    },
    frame: {
      bare: '',
      standard:
        'grid min-w-0 items-center gap-x-4 gap-y-1 rounded-lg px-3.5 py-3',
    },
    transition: {
      none: '',
      normal:
        'transition-colors duration-(--duration-quick) motion-reduce:transition-none',
    },
  },
  compoundVariants: [
    { lift: 'hover', selected: true, class: 'hover:bg-select-raised' },
  ],
  defaultVariants: {
    lift: 'hover',
    selected: false,
    frame: 'standard',
    transition: 'normal',
  },
});

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
  frame,
  transition,
  ...props
}: ComponentProps<'li'> & VariantProps<typeof rowVariants>) {
  return (
    <li
      className={cn(
        rowVariants({ lift, selected, frame, transition }),
        className,
      )}
      {...props}
    />
  );
}

export function DetailRowControl({
  className,
  render,
  ...props
}: useRender.ComponentProps<'button'>) {
  return useRender({
    defaultTagName: 'button',
    render,
    props: {
      ...props,
      className: cn(
        'grid w-full grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-x-3 rounded-lg px-3.5 py-3 text-left outline-none focus-ring',
        className,
      ),
    },
  });
}
