import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import { DatabaseIcon, RepeatIcon } from 'lucide-react';
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
import { findDefinition, stepTitle } from '../../../model/graph-adapter';
import type { GraphLevel } from '../../../model/graph-scopes';
import {
  outputFieldsOf,
  propertyPath,
  type OutputField,
} from '../../../model/input-mappings';

export type InsertedSource =
  | Readonly<{ kind: 'node_output'; nodeId: string; path: string }>
  | Readonly<{ kind: 'run_input'; path: string }>
  | Readonly<{ kind: 'structured_input'; port: string; path: string }>;

/** What a body step can read about the item it runs for (ADR 020). */
const loopFields: Readonly<
  Record<string, Readonly<{ label: string; type: string; name: string }>>
> = {
  item: { label: 'Whole item', type: 'any', name: 'item' },
  ordinal: { label: 'Position (0, 1, 2…)', type: 'integer', name: 'ordinal' },
};

/**
 * "Insert data": inside a For each body, the item it runs for; the output
 * fields of steps connected right before this one (from their output
 * schema); and the run input. Picking one fills the input row you were
 * editing, or adds a row named after the field.
 */
export function InsertDataPicker({
  graph,
  nodeId,
  loopPorts,
  definitions,
  disabled,
  onInsert,
}: Readonly<{
  /** The level the step is on: the workflow, or the body it's in. */
  graph: GraphLevel;
  nodeId: string;
  /** The body's inputs when the step is inside a For each; else empty. */
  loopPorts: readonly string[];
  definitions: readonly NodeDefinitionCatalogItem[];
  disabled: boolean;
  onInsert: (source: InsertedSource, fieldName: string) => void;
}>) {
  const [open, setOpen] = useState(false);
  const sourceIds = new Set(
    graph.edges.flatMap((edge) =>
      edge.target.nodeId === nodeId ? [edge.source.nodeId] : [],
    ),
  );
  const sources = graph.nodes.filter((node) => sourceIds.has(node.id));
  function pick(source: InsertedSource, fieldName: string) {
    setOpen(false);
    onInsert(source, fieldName);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        className={buttonVariants({ size: 'sm', variant: 'outline' })}
      >
        <DatabaseIcon data-icon="inline-start" />
        Insert data
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <PopoverTitle>Insert data</PopoverTitle>
        <PopoverDescription>
          {loopPorts.length > 0
            ? 'The item this body runs for, steps connected right before this one, and the run’s input.'
            : 'Steps connected right before this one, and the run’s input.'}
        </PopoverDescription>
        <ul className="mt-3 flex max-h-72 flex-col gap-3 overflow-y-auto">
          {loopPorts.length > 0 ? (
            <li>
              <p className="flex items-center gap-2 text-[0.8rem] font-semibold">
                <RepeatIcon
                  aria-hidden="true"
                  className="size-3.5 text-secondary"
                />
                This item
              </p>
              <ul className="mt-1 ml-3 flex flex-col border-l border-white/8 pl-2">
                {loopPorts.map((port) => {
                  const field = loopFields[port] ?? {
                    label: port,
                    type: 'any',
                    name: port,
                  };
                  return (
                    <li key={port}>
                      <PickButton
                        label={field.label}
                        type={field.type}
                        onClick={() => {
                          pick(
                            { kind: 'structured_input', port, path: '$' },
                            field.name,
                          );
                        }}
                      />
                    </li>
                  );
                })}
              </ul>
            </li>
          ) : null}
          {sources.map((source) => {
            const definition = findDefinition(definitions, source);
            const step = describeStep(
              source.definition.key,
              definition?.family,
            );
            return (
              <li key={source.id}>
                <p className="flex items-center gap-2 text-[0.8rem] font-semibold">
                  <StepTile step={step} size="sm" />
                  {stepTitle(source)}
                </p>
                <FieldList
                  fields={outputFieldsOf(definition?.outputSchema)}
                  onPick={(path, name) => {
                    pick(
                      { kind: 'node_output', nodeId: source.id, path },
                      name,
                    );
                  }}
                />
              </li>
            );
          })}
          <li>
            <p className="text-[0.8rem] font-semibold">Run input</p>
            <FieldList
              fields={[]}
              wholeLabel="Whole input"
              onPick={(path, name) => {
                pick({ kind: 'run_input', path }, name);
              }}
            />
          </li>
        </ul>
        {sources.length === 0 ? (
          <p className="mt-3 text-xs text-subtle-foreground">
            Connect a step into this one to use its output here.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function FieldList({
  fields,
  wholeLabel = 'Whole output',
  onPick,
}: Readonly<{
  fields: readonly OutputField[];
  wholeLabel?: string;
  onPick: (path: string, fieldName: string) => void;
}>) {
  return (
    <ul className="mt-1 ml-3 flex flex-col border-l border-white/8 pl-2">
      <li>
        <PickButton
          label={wholeLabel}
          type="object"
          onClick={() => {
            onPick('$', '');
          }}
        />
      </li>
      {fields.map((field) => (
        <li key={field.key}>
          <PickButton
            label={field.key}
            {...(field.type === undefined ? {} : { type: field.type })}
            onClick={() => {
              onPick(propertyPath(field.key), field.key);
            }}
          />
        </li>
      ))}
    </ul>
  );
}

function PickButton({
  label,
  type,
  onClick,
}: Readonly<{ label: string; type?: string; onClick: () => void }>) {
  return (
    <button
      type="button"
      className="flex w-full items-center justify-between gap-3 rounded-sm px-1.5 py-1 text-left text-[0.8rem] text-muted-foreground outline-none hover:bg-white/5 hover:text-accent-foreground focus-ring"
      onClick={onClick}
    >
      <span className="truncate">{label}</span>
      {type === undefined ? null : (
        <span className="font-mono text-[0.66rem] text-subtle-foreground">
          {type}
        </span>
      )}
    </button>
  );
}
