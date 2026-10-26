import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import { ChevronDownIcon, PaperclipIcon, PlusIcon } from 'lucide-react';
import { useState, type ReactNode, type Ref } from 'react';
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
import type { GraphLevel, WorkflowNode } from '../../../model/graph/scopes';
import { directPredecessorOptions } from '../../../model/inspector/input-mappings/draft';
import {
  allFormFilesPath,
  formFilesFor,
  runInputMayCarryFile,
} from '../../../model/inspector/input-mappings/form-files';
import {
  fileFieldsOf,
  propertyPath,
} from '../../../model/inspector/input-mappings/schema';
import { useEditorStore } from '../../../model/state/context';

type Choice = Readonly<{
  key: string;
  label: string;
  /** The choice in full for screen readers: "file from Weekly report". */
  name: string;
  hint?: string;
  pick: () => void;
}>;

function ChoiceGroup({
  title,
  choices,
  onPicked,
}: Readonly<{
  title: ReactNode;
  choices: readonly Choice[];
  onPicked: () => void;
}>) {
  return (
    <li>
      <p className="flex items-center gap-2 text-[0.8rem] font-semibold">
        {title}
      </p>
      <ul className="mt-1 ml-3 flex flex-col border-l border-surface-ink/8 pl-2">
        {choices.map((choice) => (
          <li key={choice.key}>
            <button
              type="button"
              aria-label={choice.name}
              className="flex w-full items-center justify-between gap-3 rounded-sm px-1.5 py-1.5 text-left max-sm:min-h-11 text-[0.8rem] text-muted-foreground outline-none hover:bg-surface-ink/5 hover:text-accent-foreground focus-ring"
              onClick={() => {
                onPicked();
                choice.pick();
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
          </li>
        ))}
      </ul>
    </li>
  );
}

type Picks = Readonly<{
  onPick: (source: ValueSource | undefined) => void;
  onPickList: (source: ValueSource) => void;
}>;

/**
 * Every file the picker offers: under each step linked right before this
 * one, its file outputs and a Request input's file questions; under the run
 * input, a Form's file questions and, unless only Forms start the run, `file`.
 */
function attachChoices(
  scope: Readonly<{
    workflow: GraphLevel;
    graph: GraphLevel;
    nodeId: string;
    definitions: readonly NodeDefinitionCatalogItem[];
  }>,
  { onPick, onPickList }: Picks,
) {
  const { workflow, graph, nodeId, definitions } = scope;
  const steps = new Map<WorkflowNode, Choice[]>();
  const offer = (step: WorkflowNode, choice: Choice) => {
    steps.set(step, [...(steps.get(step) ?? []), choice]);
  };
  for (const { nodeId: sourceId } of directPredecessorOptions(graph, nodeId)) {
    const source = graph.nodes.find((node) => node.id === sourceId);
    if (source === undefined) continue;
    const definition = findDefinition(definitions, source);
    for (const field of fileFieldsOf(
      definition?.outputSchema,
      source,
      definition?.outputVariant,
    ))
      offer(source, {
        key: field.key,
        label: field.key,
        name: `${field.key} from ${stepTitle(source)}`,
        hint: field.sometimes ? 'if saved as a file' : propertyPath(field.key),
        pick: () => {
          onPick({
            kind: 'node_output',
            nodeId: source.id,
            path: propertyPath(field.key),
          });
        },
      });
  }
  const forms = formFilesFor(workflow, graph, nodeId);
  const runInput: Choice[] = [];
  for (const form of forms)
    for (const field of form.fields) {
      const choice: Choice = {
        key: `${form.step.id}:${field.name}`,
        label: `all files from ${field.label}`,
        name: `all files from ${field.label}`,
        hint: allFormFilesPath(field),
        pick: () => {
          onPickList(form.read(allFormFilesPath(field)));
        },
      };
      if (form.origin === 'run_input') runInput.push(choice);
      else offer(form.step, choice);
    }
  if (runInputMayCarryFile(workflow))
    runInput.push({
      key: 'file',
      label: 'file',
      name: 'file from the run input',
      hint: '$.file',
      pick: () => {
        onPick({ kind: 'run_input', path: '$.file' });
      },
    });
  return { steps: [...steps], runInput, fromForms: forms.length > 0 };
}

function StepTitle({
  step,
  definitions,
}: Readonly<{
  step: WorkflowNode;
  definitions: readonly NodeDefinitionCatalogItem[];
}>) {
  return (
    <>
      <StepTile
        step={describeStep(
          step.definition.key,
          findDefinition(definitions, step)?.family,
        )}
        size="sm"
      />
      {stepTitle(step)}
    </>
  );
}

/**
 * "Attach a file": the file outputs of steps linked right before this one,
 * every file a form question received, the run input's `file`, or any other
 * source picked in the row itself.
 */
export function AttachPicker({
  triggerRef,
  graph,
  nodeId,
  definitions,
  disabled,
  onPick,
  onPickList,
}: Readonly<{
  /** Takes focus when the last attachment is removed. */
  triggerRef?: Ref<HTMLButtonElement>;
  graph: GraphLevel;
  nodeId: string;
  definitions: readonly NodeDefinitionCatalogItem[];
  disabled: boolean;
  /** Undefined asks for an empty row whose source is chosen in place. */
  onPick: (source: ValueSource | undefined) => void;
  /** A list of `{ file, filename }` attached as a whole, such as a form's files. */
  onPickList: (source: ValueSource) => void;
}>) {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
  };
  const choices = attachChoices(
    {
      workflow: useEditorStore((state) => state.graph),
      graph,
      nodeId,
      definitions,
    },
    { onPick, onPickList },
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={triggerRef}
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
          Files made by steps linked right before this one, or files passed in
          with the run.
        </PopoverDescription>
        <ul className="mt-3 flex max-h-72 flex-col gap-3 overflow-y-auto">
          {choices.steps.map(([step, offered]) => (
            <ChoiceGroup
              key={step.id}
              title={<StepTitle step={step} definitions={definitions} />}
              choices={offered}
              onPicked={close}
            />
          ))}
          {choices.runInput.length === 0 ? null : (
            <ChoiceGroup
              title="Run input"
              choices={choices.runInput}
              onPicked={close}
            />
          )}
          <li className="border-t border-surface-ink/7 pt-2">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1.5 text-left max-sm:min-h-11 text-[0.8rem] text-muted-foreground outline-none hover:bg-surface-ink/5 hover:text-accent-foreground focus-ring"
              onClick={() => {
                close();
                onPick(undefined);
              }}
            >
              <PlusIcon aria-hidden="true" className="size-3.5" />
              Another source…
            </button>
          </li>
        </ul>
        {choices.steps.length === 0 && !choices.fromForms ? (
          <p className="mt-3 text-xs text-subtle-foreground">
            Link a step that makes a file, such as Create file, into this one to
            attach its output.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
