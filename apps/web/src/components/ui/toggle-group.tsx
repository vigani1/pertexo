import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/class-names';

const groupVariants = cva('inline-flex w-fit items-center', {
  variants: {
    appearance: {
      segmented: 'gap-0.5 rounded-md border border-border bg-well p-[3px]',
      frameless: 'gap-1.5',
    },
  },
  defaultVariants: { appearance: 'segmented' },
});

const itemVariants = cva(
  "inline-flex max-sm:min-h-[var(--control-min-size,2.75rem)] max-sm:min-w-[var(--control-min-size,2.75rem)] items-center gap-1.5 px-3 text-meta font-medium whitespace-nowrap text-subtle-foreground transition-colors outline-none hover:bg-select hover:text-foreground focus-ring pointer-coarse:min-h-10 pointer-coarse:min-w-10 disabled:pointer-events-none disabled:opacity-50 data-pressed:text-foreground [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      appearance: {
        segmented:
          'h-7 rounded-sm data-pressed:bg-raised data-pressed:inset-ring data-pressed:inset-ring-border-strong',
        pill: 'h-8 rounded-full border border-surface-ink/10 data-pressed:border-action/55 data-pressed:bg-action/12',
        tile: 'h-auto rounded-md border border-border bg-well data-pressed:border-action/55 data-pressed:bg-action/12',
      },
    },
    defaultVariants: { appearance: 'segmented' },
  },
);

// A segmented control for small, mutually exclusive option sets (2–7 items).
export function ToggleGroup({
  className,
  appearance,
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
  className,
  appearance,
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
