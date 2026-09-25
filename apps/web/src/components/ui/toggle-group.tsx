import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import { cn } from '@/lib/utils';

// A segmented control for small, mutually exclusive option sets (2–7 items).
export function ToggleGroup({
  className,
  ...props
}: ToggleGroupPrimitive.Props) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={cn(
        'inline-flex w-fit items-center gap-0.5 rounded-md border border-white/7 bg-white/[0.035] p-[3px]',
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
        "inline-flex h-7 items-center gap-1.5 rounded-sm px-3 text-[0.8rem] font-medium whitespace-nowrap text-subtle-foreground transition-colors outline-none hover:text-foreground focus-ring disabled:pointer-events-none disabled:opacity-50 data-pressed:bg-white/8 data-pressed:text-foreground data-pressed:shadow-[inset_0_1px_0_rgb(255_255_255/6%)] [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}
