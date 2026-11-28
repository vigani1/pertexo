import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { cn } from '@/lib/class-names';

export const Tabs = TabsPrimitive.Root;

export function TabsList({
  className,
  divided = false,
  ...props
}: TabsPrimitive.List.Props & Readonly<{ divided?: boolean }>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'flex min-w-0 items-center gap-1 overflow-x-auto p-0.5',
        divided && 'border-b border-border',
        className,
      )}
      {...props}
    />
  );
}

export const tabTileClass =
  "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-sm px-3 text-label font-medium whitespace-nowrap text-subtle-foreground outline-none -outline-offset-2 transition-colors hover:bg-select hover:text-foreground focus-ring disabled:pointer-events-none disabled:opacity-50 data-active:bg-select-raised data-active:text-foreground data-active:inset-ring data-active:inset-ring-border pointer-coarse:min-h-10 [&_svg:not([class*='size-'])]:size-4 aria-[current=page]:bg-select-raised aria-[current=page]:text-foreground aria-[current=page]:inset-ring aria-[current=page]:inset-ring-border";

export function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(tabTileClass, className)}
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
