import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/class-names';

const groupVariants = cva('inline-flex w-fit items-center gap-0.5', {
  variants: {
    appearance: {
      segmented: 'rounded-md border border-border bg-well p-[3px]',
      frameless: '',
    },
  },
  defaultVariants: { appearance: 'segmented' },
});

const itemVariants = cva(
  "inline-flex max-sm:min-h-[var(--control-min-size,2.75rem)] max-sm:min-w-[var(--control-min-size,2.75rem)] items-center whitespace-nowrap outline-none hover:text-foreground focus-ring pointer-coarse:min-h-10 pointer-coarse:min-w-10 disabled:pointer-events-none disabled:opacity-50 data-pressed:text-foreground [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      appearance: {
        segmented:
          'h-7 gap-1.5 rounded-sm px-3 text-meta font-medium text-subtle-foreground transition-colors hover:bg-select data-pressed:bg-raised data-pressed:inset-ring data-pressed:inset-ring-border-strong',
        pill: 'h-8 gap-1.5 rounded-full border border-surface-ink/10 px-3 text-meta font-medium text-subtle-foreground transition-colors hover:bg-select data-pressed:border-action/55 data-pressed:bg-action/12',
        tile: 'group/tile relative flex h-[4.25rem] min-w-0 flex-col justify-center gap-1 rounded-lg border border-surface-ink/8 bg-select px-1 text-muted-foreground transition-[transform,box-shadow,border-color,background-color,color] duration-(--duration-move) ease-unspool motion-reduce:transition-none hover:border-surface-ink/16 data-pressed:-translate-y-px data-pressed:border-transparent data-pressed:bg-action-soft data-pressed:shadow-lens data-pressed:outline-2 data-pressed:outline-offset-0 data-pressed:outline-ring/70 motion-reduce:data-pressed:translate-y-0 max-sm:min-h-[4.25rem]',
      },
    },
    defaultVariants: { appearance: 'segmented' },
  },
);

// A segmented control for small, mutually exclusive option sets (2–7 items).
export function ToggleGroup({
  appearance,
  className,
  ...props
}: ToggleGroupPrimitive.Props & VariantProps<typeof groupVariants>) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={cn(groupVariants({ appearance }), className)}
      {...props}
    />
  );
}

export function ToggleGroupItem({
  appearance,
  className,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof itemVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(itemVariants({ appearance }), className)}
      {...props}
    />
  );
}
