import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import { useDeferredValue, useState, type Ref } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import type { StepChoice } from '../../model/step-catalog';
import { firstStepChoice } from '../../model/step-catalog';
import { StepChoiceList, StepSearch } from './step-picker';

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
        <StepSearch
          query={query}
          onQueryChange={setQuery}
          onPickFirst={() => {
            const first = firstStepChoice(definitions, query);
            if (first !== undefined) onAdd(first);
          }}
          inputRef={searchRef}
        >
          <Kbd>/</Kbd>
        </StepSearch>
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
        <StepChoiceList
          definitions={definitions}
          query={deferredQuery}
          onPick={onAdd}
        />
      </div>
    </div>
  );
}
