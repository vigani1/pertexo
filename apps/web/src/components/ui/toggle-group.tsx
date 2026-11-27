import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import { cn } from '@/lib/class-names';

// A segmented control for small, mutually exclusive option sets (2–7 items).
export function ToggleGroup({
  className,
  ...props
}: ToggleGroupPrimitive.Props) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={cn(
        'inline-flex w-fit items-center gap-0.5 rounded-md border border-border bg-well p-[3px]',
        className,
      )}
      {...props}
    />
  );
}

export function ToggleGroupItem({
  className,
  ...props
}: TogglePrimitive.Props) {
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex h-7 max-sm:min-h-[var(--control-min-size,2.75rem)] max-sm:min-w-[var(--control-min-size,2.75rem)] items-center gap-1.5 rounded-sm px-3 text-meta font-medium whitespace-nowrap text-subtle-foreground transition-colors outline-none hover:bg-select hover:text-foreground focus-ring pointer-coarse:min-h-10 pointer-coarse:min-w-10 disabled:pointer-events-none disabled:opacity-50 data-pressed:bg-raised data-pressed:text-foreground data-pressed:inset-ring data-pressed:inset-ring-border-strong [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}
