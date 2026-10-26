import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import { ChevronDownIcon, PaperclipIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { describeStep, StepTile } from '@/features/catalog/presentation.public';
import type { ValueSource } from '@pertexo/workflow-model';
import { findDefinition, stepTitle } from '../../../model/graph/adapter';
import type { GraphLevel } from '../../../model/graph/scopes';
import { directPredecessorOptions } from '../../../model/inspector/input-mappings/draft';
import {
  fileFieldsOf,
  propertyPath,
} from '../../../model/inspector/input-mappings/schema';

type Choice = Readonly<{
  label: string;
  /** The choice in full for screen readers: "file from Weekly report". */
  name: string;
  hint?: string;
  source: ValueSource | undefined;
}>;

function ChoiceButton({
  choice,
  onPick,
}: Readonly<{ choice: Choice; onPick: (source: Choice['source']) => void }>) {
  return (
    <button
      type="button"
      aria-label={choice.name}
      className="flex w-full items-center justify-between gap-3 rounded-sm px-1.5 py-1.5 text-left text-[0.8rem] text-muted-foreground outline-none hover:bg-surface-ink/5 hover:text-accent-foreground focus-ring"
      onClick={() => {
        onPick(choice.source);
      }}
    >
      <span className="truncate">{choice.label}</span>
      {choice.hint === undefined ? null : (
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-[0.66rem] text-subtle-foreground"
        >
          {choice.hint}
        </span>
      )}
    </button>
  );
}

/**
 * "Attach a file": the file outputs of steps linked right before this one,
 * the run input's `file`, or any other source picked in the row itself.
 */
export function AttachPicker({
  graph,
  nodeId,
  definitions,
  disabled,
  onPick,
}: Readonly<{
  graph: GraphLevel;
  nodeId: string;
  definitions: readonly NodeDefinitionCatalogItem[];
  disabled: boolean;
  /** Undefined asks for an empty row whose source is chosen in place. */
  onPick: (source: ValueSource | undefined) => void;
}>) {
  const [open, setOpen] = useState(false);
  const steps = directPredecessorOptions(graph, nodeId).flatMap(
    ({ nodeId: sourceId }) => {
      const source = graph.nodes.find((node) => node.id === sourceId);
      if (source === undefined) return [];
      const definition = findDefinition(definitions, source);
      const fields = fileFieldsOf(
        definition?.outputSchema,
        source,
        definition?.outputVariant,
      );
      return fields.length === 0
        ? []
        : [{ source, family: definition?.family, fields }];
    },
  );
  function pick(source: ValueSource | undefined) {
    setOpen(false);
    onPick(source);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        className={buttonVariants({ size: 'sm', variant: 'outline' })}
      >
        <PaperclipIcon data-icon="inline-start" />
        Attach a file
        <ChevronDownIcon data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <PopoverTitle>Attach a file</PopoverTitle>
        <PopoverDescription>
          Files made by steps linked right before this one, or a file passed in
          with the run.
        </PopoverDescription>
        <ul className="mt-3 flex max-h-72 flex-col gap-3 overflow-y-auto">
          {steps.map(({ source, family, fields }) => (
            <li key={source.id}>
              <p className="flex items-center gap-2 text-[0.8rem] font-semibold">
                <StepTile
                  step={describeStep(source.definition.key, family)}
                  size="sm"
                />
                {stepTitle(source)}
              </p>
              <ul className="mt-1 ml-3 flex flex-col border-l border-surface-ink/8 pl-2">
                {fields.map((field) => (
                  <li key={field.key}>
                    <ChoiceButton
                      choice={{
                        label: field.key,
                        name: `${field.key} from ${stepTitle(source)}`,
                        hint: field.sometimes
                          ? 'if saved as a file'
                          : propertyPath(field.key),
                        source: {
                          kind: 'node_output',
                          nodeId: source.id,
                          path: propertyPath(field.key),
                        },
                      }}
                      onPick={pick}
                    />
                  </li>
                ))}
              </ul>
            </li>
          ))}
          <li>
            <p className="text-[0.8rem] font-semibold">Run input</p>
            <ul className="mt-1 ml-3 flex flex-col border-l border-surface-ink/8 pl-2">
              <li>
                <ChoiceButton
                  choice={{
                    label: 'file',
                    name: 'file from the run input',
                    hint: '$.file',
                    source: { kind: 'run_input', path: '$.file' },
                  }}
                  onPick={pick}
                />
              </li>
            </ul>
          </li>
          <li className="border-t border-surface-ink/7 pt-2">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1.5 text-left text-[0.8rem] text-muted-foreground outline-none hover:bg-surface-ink/5 hover:text-accent-foreground focus-ring"
              onClick={() => {
                pick(undefined);
              }}
            >
              <PlusIcon aria-hidden="true" className="size-3.5" />
              Another source…
            </button>
          </li>
        </ul>
        {steps.length === 0 ? (
          <p className="mt-3 text-xs text-subtle-foreground">
            Link a step that makes a file, such as Create file, into this one to
            attach its output.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
