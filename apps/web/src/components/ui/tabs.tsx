import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { cn } from '@/lib/utils';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'flex min-w-0 items-center gap-2 overflow-x-auto overflow-y-hidden border-b border-border',
        className,
      )}
      {...props}
    />
  );
}

// A glowing cyan thread marks the active tab. It sits inside the list: the
// list scrolls sideways on phones, which clips anything below its border. The
// focus ring is drawn inside the tab for the same reason.
export function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex max-sm:min-h-[var(--control-min-size,2.75rem)] items-center gap-1.5 rounded-sm px-1.5 py-2.5 text-sm font-medium whitespace-nowrap text-subtle-foreground -outline-offset-2 transition-colors hover:text-foreground focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-50 data-active:text-foreground [&_svg:not([class*='size-'])]:size-4",
        'after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-action after:opacity-0 after:transition-opacity data-active:after:opacity-100',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      // A panel takes focus on Tab, so it shows the ring like everything else.
      className={cn('min-w-0 rounded-sm outline-none focus-ring', className)}
      {...props}
    />
  );
}
