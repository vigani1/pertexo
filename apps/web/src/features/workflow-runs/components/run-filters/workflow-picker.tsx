import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { SearchIcon } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import {
  Autocomplete,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
} from '@/components/ui/autocomplete';

function startsWith(workflow: WorkflowSummary, query: string): boolean {
  return workflow.name
    .toLocaleLowerCase()
    .startsWith(query.trim().toLocaleLowerCase());
}

/**
 * Typeahead over workflow names. Picking a suggestion filters by that exact
 * workflow; pressing Enter on free text filters by names starting with it.
 * Remount (key) it when the URL filter changes so the text follows the URL.
 */
export function WorkflowPicker({
  workflows,
  initialText,
  onPickWorkflow,
  onNamePrefix,
}: Readonly<{
  workflows: readonly WorkflowSummary[];
  initialText: string;
  onPickWorkflow: (workflow: WorkflowSummary) => void;
  onNamePrefix: (prefix: string | undefined) => void;
}>) {
  const [text, setText] = useState(initialText);

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const prefix = text.trim();
    onNamePrefix(prefix === '' ? undefined : prefix);
  }

  return (
    <form
      role="search"
      className="relative col-span-2 w-full sm:w-56 lg:w-64"
      onSubmit={submit}
    >
      <label htmlFor="run-workflow-filter" className="sr-only">
        Workflow name
      </label>
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-subtle-foreground"
      />
      <Autocomplete
        items={workflows}
        value={text}
        onValueChange={(value) => {
          setText(value);
        }}
        itemToStringValue={(workflow: WorkflowSummary) => workflow.name}
        filter={startsWith}
        limit={8}
      >
        <AutocompleteInput
          id="run-workflow-filter"
          placeholder="Workflow name…"
          autoComplete="off"
          className="pl-8"
        />
        <AutocompleteContent>
          <AutocompleteEmpty>
            No workflow starts with that. Press Enter to search anyway.
          </AutocompleteEmpty>
          <AutocompleteList>
            {(workflow: WorkflowSummary) => (
              <AutocompleteItem
                key={workflow.id}
                value={workflow}
                onClick={() => {
                  onPickWorkflow(workflow);
                }}
              >
                <span className="truncate">{workflow.name}</span>
              </AutocompleteItem>
            )}
          </AutocompleteList>
        </AutocompleteContent>
      </Autocomplete>
      {/* Enter with no suggestion highlighted submits the typed prefix. */}
      <button type="submit" tabIndex={-1} className="sr-only">
        Filter by name
      </button>
    </form>
  );
}
