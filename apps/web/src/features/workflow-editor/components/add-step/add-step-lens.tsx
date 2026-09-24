import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import {
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SearchIcon,
} from 'lucide-react';
import { useDeferredValue, useState, type Ref } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { groupStepChoices, type StepChoice } from '../../model/step-catalog';
import { AddStepItem } from './add-step-item';

/**
 * The add-step lens: search with "/", steps under human group names, click
 * to drop a step in view or drag it to a spot. ⌘B folds it to a strip.
 */
export function AddStepLens({
  definitions,
  collapsed,
  searchRef,
  onToggleCollapsed,
  onAdd,
}: Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  collapsed: boolean;
  searchRef: Ref<HTMLInputElement>;
  onToggleCollapsed: () => void;
  onAdd: (choice: StepChoice) => void;
}>) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const groups = groupStepChoices(definitions, deferredQuery);
  if (collapsed)
    return (
      <div className="flex flex-col items-center gap-1 py-1.5">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Show steps"
          aria-expanded="false"
          onClick={onToggleCollapsed}
        >
          <PanelLeftOpenIcon />
        </Button>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 px-3 pt-3">
        <label className="recessed-control flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border px-2.5 focus-within:border-primary">
          <SearchIcon
            aria-hidden="true"
            className="size-3.5 text-subtle-foreground"
          />
          <span className="sr-only">Search steps</span>
          <input
            ref={searchRef}
            type="search"
            name="stepSearch"
            autoComplete="off"
            placeholder="Add a step"
            value={query}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle-foreground"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query !== '') {
                event.stopPropagation();
                setQuery('');
              }
            }}
          />
          <Kbd>/</Kbd>
        </label>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Hide steps"
          aria-expanded="true"
          className="hidden lg:inline-flex"
          onClick={onToggleCollapsed}
        >
          <PanelLeftCloseIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3">
        {groups.length === 0 ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            {query.trim() === ''
              ? 'No steps are available to add right now.'
              : `No steps match “${query.trim()}”.`}
          </p>
        ) : (
          groups.map((group) => (
            <section
              key={group.family}
              aria-labelledby={`add-step-${group.family}`}
              className="mt-3"
            >
              <h3
                id={`add-step-${group.family}`}
                className="px-1.5 text-[0.72rem] font-semibold text-subtle-foreground"
              >
                {group.title}
              </h3>
              <ul className="mt-1 flex flex-col">
                {group.choices.map((choice) => (
                  <li key={choice.identity}>
                    <AddStepItem choice={choice} onAdd={onAdd} />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
