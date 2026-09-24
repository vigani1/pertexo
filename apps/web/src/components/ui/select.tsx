import { Select as SelectPrimitive } from '@base-ui/react/select';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { popupSurface } from './popup-surface';

export const Select = SelectPrimitive.Root;

export function SelectTrigger({
  className,
  children,
  ...props
}: SelectPrimitive.Trigger.Props) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "recessed-control flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border px-3 text-sm whitespace-nowrap outline-none select-none data-placeholder:text-subtle-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      {/* Explicit children: Base UI's default icon is a text "▼" glyph. */}
      <SelectPrimitive.Icon className="flex text-subtle-foreground">
        <ChevronDownIcon aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectValue({
  className,
  ...props
}: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn('min-w-0 flex-1 truncate text-left', className)}
      {...props}
    />
  );
}

export function SelectContent({
  className,
  children,
  sideOffset = 6,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<SelectPrimitive.Positioner.Props, 'sideOffset'>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        sideOffset={sideOffset}
        alignItemWithTrigger={false}
        className="z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            popupSurface,
            'max-h-(--available-height) w-(--anchor-width) min-w-40 overflow-y-auto p-1',
            className,
          )}
          {...props}
        >
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-white/6 data-highlighted:text-foreground',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="flex min-w-0 flex-1 gap-2">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center text-primary" />
        }
      >
        <CheckIcon className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function SelectGroup({
  className,
  ...props
}: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn('py-1', className)}
      {...props}
    />
  );
}

export function SelectLabel({
  className,
  ...props
}: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn(
        'px-2 py-1 font-mono text-[0.68rem] tracking-wide text-subtle-foreground uppercase',
        className,
      )}
      {...props}
    />
  );
}
