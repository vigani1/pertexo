import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import { SearchIcon } from 'lucide-react';
import { useId, type ReactNode, type Ref } from 'react';
import { cn } from '@/lib/utils';
import { groupStepChoices, type StepChoice } from '../../model/step-catalog';
import { AddStepBundle } from './add-step-bundle';
import { AddStepItem } from './add-step-item';

/**
 * The step search field shared by the add-step lens and quick add. Enter
 * adds the first match; Escape clears a query before it closes anything
 * around it.
 */
export function StepSearch({
  query,
  onQueryChange,
  onPickFirst,
  inputRef,
  className,
  children,
}: Readonly<{
  query: string;
  onQueryChange: (query: string) => void;
  onPickFirst: () => void;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
  /** Trailing hint inside the field, such as its shortcut. */
  children?: ReactNode;
}>) {
  return (
    <label
      className={cn(
        'recessed-control flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border px-2.5',
        className,
      )}
    >
      <SearchIcon
        aria-hidden="true"
        className="size-3.5 text-subtle-foreground"
      />
      <span className="sr-only">Search steps</span>
      <input
        ref={inputRef}
        type="search"
        name="stepSearch"
        autoComplete="off"
        placeholder="Add a step"
        value={query}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle-foreground"
        onChange={(event) => {
          onQueryChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && query.trim() !== '') {
            event.preventDefault();
            onPickFirst();
          }
          if (event.key === 'Escape' && query !== '') {
            event.stopPropagation();
            onQueryChange('');
          }
        }}
      />
      {children}
    </label>
  );
}

/** The first step a search lists, which Enter adds. */
export function firstStepChoice(
  definitions: readonly NodeDefinitionCatalogItem[],
  query: string,
): StepChoice | undefined {
  return groupStepChoices(definitions, query)[0]?.choices[0];
}

/**
 * Placeable steps under their human group names, filtered by `query`. While
 * browsing, Switch, Parallel and Merge share one row that opens in place.
 */
export function StepChoiceList({
  definitions,
  query,
  onPick,
}: Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  query: string;
  onPick: (choice: StepChoice) => void;
}>) {
  const idPrefix = useId();
  const groups = groupStepChoices(definitions, query);
  if (groups.length === 0)
    return (
      <p className="px-2 py-4 text-sm text-muted-foreground">
        {query.trim() === ''
          ? 'No steps are available to add right now.'
          : `No steps match “${query.trim()}”.`}
      </p>
    );
  return groups.map((group) => {
    const headingId = `${idPrefix}-${group.family}`;
    return (
      <section key={group.family} aria-labelledby={headingId} className="mt-3">
        <h3
          id={headingId}
          className="px-1.5 font-mono text-[0.68rem] font-semibold tracking-wide text-subtle-foreground uppercase"
        >
          {group.title}
        </h3>
        <ul className="mt-1 flex flex-col">
          {group.entries.map((entry) =>
            entry.kind === 'step' ? (
              <li key={entry.choice.identity}>
                <AddStepItem choice={entry.choice} onAdd={onPick} />
              </li>
            ) : (
              <li key={entry.bundle.id}>
                <AddStepBundle bundle={entry.bundle} onAdd={onPick} />
              </li>
            ),
          )}
        </ul>
      </section>
    );
  });
}
