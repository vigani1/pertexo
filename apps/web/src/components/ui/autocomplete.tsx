import { Autocomplete as AutocompletePrimitive } from '@base-ui/react/autocomplete';
import { cn } from '@/lib/utils';
import { popupSurface } from './popup-surface';

// A free-text input that suggests matching items as you type (typeahead).
// The caller owns the items, the input value and what picking an item does.
export const Autocomplete = AutocompletePrimitive.Root;

export function AutocompleteInput({
  className,
  ...props
}: AutocompletePrimitive.Input.Props) {
  return (
    <AutocompletePrimitive.Input
      data-slot="autocomplete-input"
      className={cn(
        'recessed-control h-9 w-full min-w-0 rounded-md border px-3 py-2 text-base md:text-sm',
        className,
      )}
      {...props}
    />
  );
}

export function AutocompleteContent({
  className,
  children,
  sideOffset = 6,
  ...props
}: AutocompletePrimitive.Popup.Props &
  Pick<AutocompletePrimitive.Positioner.Props, 'sideOffset'>) {
  return (
    <AutocompletePrimitive.Portal>
      <AutocompletePrimitive.Positioner
        sideOffset={sideOffset}
        className="z-50"
      >
        <AutocompletePrimitive.Popup
          data-slot="autocomplete-content"
          className={cn(
            popupSurface,
            'max-h-[min(20rem,var(--available-height))] w-(--anchor-width) min-w-56 overflow-y-auto p-1',
            className,
          )}
          {...props}
        >
          {children}
        </AutocompletePrimitive.Popup>
      </AutocompletePrimitive.Positioner>
    </AutocompletePrimitive.Portal>
  );
}

export const AutocompleteList = AutocompletePrimitive.List;

export function AutocompleteItem({
  className,
  ...props
}: AutocompletePrimitive.Item.Props) {
  return (
    <AutocompletePrimitive.Item
      data-slot="autocomplete-item"
      className={cn(
        'flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground outline-none select-none data-highlighted:bg-white/6 data-highlighted:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function AutocompleteEmpty({
  className,
  ...props
}: AutocompletePrimitive.Empty.Props) {
  return (
    <AutocompletePrimitive.Empty
      data-slot="autocomplete-empty"
      className={cn(
        'px-2 py-2 text-sm text-subtle-foreground empty:hidden',
        className,
      )}
      {...props}
    />
  );
}
