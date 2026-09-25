import { useState, type ReactNode } from 'react';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { SearchIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';

export type CommandItem = Readonly<{
  id: string;
  label: string;
  /** Extra words that should match, e.g. a route name or synonyms. */
  keywords?: string;
  hint?: string;
  icon?: ReactNode;
  onSelect: () => void;
}>;

export type CommandGroup = Readonly<{
  label: string;
  items: readonly CommandItem[];
}>;

function matches(item: CommandItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return `${item.label} ${item.keywords ?? ''}`.toLowerCase().includes(needle);
}

/**
 * ⌘K lens: one searchable list of places and actions. Callers own which
 * groups exist; `resolveQuery` can add items derived from the typed text,
 * such as opening a run by its pasted ID.
 */
export function CommandPalette({
  open,
  onOpenChange,
  groups,
  resolveQuery,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: readonly CommandGroup[];
  resolveQuery?: (query: string) => CommandGroup | undefined;
}>) {
  const [query, setQuery] = useState('');
  const dynamic = resolveQuery?.(query.trim());
  const visibleGroups = [...(dynamic === undefined ? [] : [dynamic]), ...groups]
    .map((group) => ({
      label: group.label,
      items: group.items.filter((item) => matches(item, query)),
    }))
    .filter((group) => group.items.length > 0);

  function choose(item: CommandItem) {
    onOpenChange(false);
    setQuery('');
    item.onSelect();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('');
        onOpenChange(next);
      }}
    >
      <DialogContent placement="top" className="overflow-hidden">
        <DialogTitle className="sr-only">Search Pertexo</DialogTitle>
        <Autocomplete.Root
          inline
          open
          items={visibleGroups}
          filteredItems={visibleGroups}
          value={query}
          onValueChange={setQuery}
          autoHighlight="always"
          itemToStringValue={(item: CommandItem) => item.label}
        >
          <label className="flex items-center gap-3 border-b border-border px-4">
            <SearchIcon
              aria-hidden="true"
              className="size-4 text-subtle-foreground"
            />
            <Autocomplete.Input
              aria-label="Search pages, workflows and actions"
              placeholder="Search pages, workflows and actions"
              className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-subtle-foreground"
            />
            <Kbd>Esc</Kbd>
          </label>
          {/* Always mounted; it only has children while nothing matches. */}
          <Autocomplete.Empty className="px-4 py-8 text-sm text-muted-foreground empty:hidden">
            Nothing matches “{query}”.
          </Autocomplete.Empty>
          <Autocomplete.List className="max-h-[min(26rem,60svh)] overflow-y-auto overscroll-contain p-2 data-empty:p-0">
            {(group: CommandGroup) => (
              <Autocomplete.Group
                key={group.label}
                items={[...group.items]}
                className="pb-2 last:pb-0"
              >
                <Autocomplete.GroupLabel className="px-2 py-1.5 font-mono text-[0.68rem] tracking-wide text-subtle-foreground uppercase">
                  {group.label}
                </Autocomplete.GroupLabel>
                <Autocomplete.Collection>
                  {(item: CommandItem) => (
                    <Autocomplete.Item
                      key={item.id}
                      value={item}
                      onClick={() => {
                        choose(item);
                      }}
                      className="flex cursor-default items-center gap-3 rounded-md px-2 py-2 text-sm text-muted-foreground outline-none select-none data-highlighted:bg-white/6 data-highlighted:text-foreground [&_svg:not([class*='size-'])]:size-4"
                    >
                      {item.icon}
                      <span className="min-w-0 flex-1 truncate">
                        {item.label}
                      </span>
                      {item.hint === undefined ? null : (
                        <span className="font-mono text-[0.7rem] text-subtle-foreground">
                          {item.hint}
                        </span>
                      )}
                    </Autocomplete.Item>
                  )}
                </Autocomplete.Collection>
              </Autocomplete.Group>
            )}
          </Autocomplete.List>
        </Autocomplete.Root>
      </DialogContent>
    </Dialog>
  );
}
