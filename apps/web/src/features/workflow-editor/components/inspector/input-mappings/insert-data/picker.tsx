import { VariablePicker } from '@/features/workspace-variables/picker.public';
import {
  callbackTargetNodes,
  isWorkflowTriggerDefinition,
  WORKFLOW_FAILURE_PORT,
  WORKFLOW_FAILURE_FIELDS,
} from '@pertexo/workflow-model';
import { StatusGlyph } from '@/components/ui/status';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import { DatabaseIcon } from 'lucide-react';
import { useState, type ReactNode, type Ref } from 'react';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { findDefinition } from '../../../../model/graph/adapter';
import { upstreamStepIds } from '../../../../model/graph/order';
import type { GraphLevel } from '../../../../model/graph/scopes';
import { useEditorStore } from '../../../../model/state/context';
import { directPredecessorOptions } from '../../../../model/inspector/input-mappings/draft';
import { fieldTree } from '../../../../model/inspector/input-mappings/fields';
import { formFilesToRead } from '../../../../model/inspector/input-mappings/form-files';
import {
  sourceReference,
  type InsertedSource,
} from '../../../../model/inspector/input-mappings/reference';
import {
  CallbackInputChoices,
  FirstFormFiles,
  LoopInputChoices,
} from './choices';
import { FieldList, type FieldPick } from './field-tree';
import { StepFields } from './step-fields';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';

type PickerTrigger = Readonly<{
  id: string;
  className: string;
  content: ReactNode;
  describedBy?: string;
  ref?: Ref<HTMLButtonElement> | undefined;
}>;

export type InsertDataProps = Readonly<{
  /** The level the step is on: the workflow, or the body it's in. */
  allowFailure?: boolean;
  graph: GraphLevel;
  variableScope?: WorkspaceApiScope;
  nodeId: string;
  /** The body's inputs when the step is inside a For each; else empty. */
  loopPorts: readonly string[];
  definitions: readonly NodeDefinitionCatalogItem[];
  disabled: boolean;
  /** The type is the field's, when it's known. */
  onInsert: (
    source: InsertedSource,
    fieldName: string,
    type: string | undefined,
  ) => void;
  /** The whole workflow, whose Form's files a step that reads a file is offered. */
  workflow?: GraphLevel;
  /** Its opener, when it isn't the usual Insert data button. */
  trigger?: PickerTrigger;
}>;

/**
 * "Insert data": inside a For each body, the item it runs for; every step
 * before this one, with the fields it declares and the ones it really
 * returned; and the run input. A step that reads a file is also offered the
 * first file each form question received. Picking one fills the input row
 * you were editing, or adds a row named after the field.
 */
export function InsertDataPicker({
  disabled,
  trigger,
  onInsert,
  ...choices
}: InsertDataProps) {
  const [open, setOpen] = useState(false);
  function pick(
    source: InsertedSource,
    fieldName: string,
    type: string | undefined,
  ) {
    setOpen(false);
    onInsert(source, fieldName, type);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        {...(trigger === undefined
          ? { className: buttonVariants({ size: 'sm', variant: 'outline' }) }
          : {
              id: trigger.id,
              className: trigger.className,
              'aria-describedby': trigger.describedBy,
              ref: trigger.ref,
            })}
      >
        {trigger === undefined ? (
          <>
            <DatabaseIcon data-icon="inline-start" />
            Insert data
          </>
        ) : (
          trigger.content
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))]">
        <PopoverTitle>Insert data</PopoverTitle>
        <PopoverDescription>
          {choices.loopPorts.length > 0
            ? 'The item this body runs for, earlier steps’ fields and the run’s input.'
            : 'Earlier steps’ fields and the run’s input, with values from their last test or run.'}
        </PopoverDescription>
        <InsertDataChoices {...choices} onPick={pick} />
      </PopoverContent>
    </Popover>
  );
}

type InsertPick = (
  source: InsertedSource,
  fieldName: string,
  type: string | undefined,
) => void;

function InsertDataChoices({
  graph,
  variableScope,
  nodeId,
  loopPorts,
  definitions,
  allowFailure = true,
  workflow,
  onPick: pick,
}: Omit<InsertDataProps, 'disabled' | 'trigger' | 'onInsert'> &
  Readonly<{ onPick: InsertPick }>) {
  const directIds = new Set(
    directPredecessorOptions(graph, nodeId).map((option) => option.nodeId),
  );
  const failureSource = allowFailure
    ? graph.edges.find(
        (edge) =>
          edge.target.nodeId === nodeId &&
          edge.source.port === WORKFLOW_FAILURE_PORT,
      )?.source.nodeId
    : undefined;
  const current = graph.nodes.find((node) => node.id === nodeId);
  const definition =
    current === undefined ? undefined : findDefinition(definitions, current);
  const callbackTargets =
    (definition?.capabilities.includes('external_http') ?? false)
      ? callbackTargetNodes(graph, nodeId)
      : [];
  const direct = graph.nodes.filter((node) => directIds.has(node.id));
  const toRead =
    workflow === undefined
      ? undefined
      : formFilesToRead(workflow, graph, nodeId, definition?.inputSchema);
  return (
    <>
      {/* A fixed height: fields loading or opening never move the popover. */}
      <ul className="mt-3 flex h-[min(20rem,50dvh)] flex-col gap-3 overflow-y-auto">
        <LoopInputChoices
          loopPorts={loopPorts}
          onPick={(source, name) => {
            pick(source, name, undefined);
          }}
        />
        {failureSource === undefined ? null : (
          <li>
            <p className="flex items-center gap-2 text-[0.8rem] font-semibold">
              <StatusGlyph tone="failure" />
              Source failure
            </p>
            <FieldList
              wholeLabel="All safe failure fields"
              {...fieldTree(WORKFLOW_FAILURE_FIELDS.map((key) => ({ key })))}
              onPick={(path, name, type) => {
                pick(
                  { kind: 'node_failure', nodeId: failureSource, path },
                  name || 'failure',
                  type,
                );
              }}
            />
          </li>
        )}
        {callbackTargets.map((target) => (
          <CallbackInputChoices
            key={`callback:${target.id}`}
            target={target}
            onPick={(source, name) => {
              pick(source, name, undefined);
            }}
          />
        ))}
        {direct.map((source) => (
          <StepFields
            key={source.id}
            step={source}
            startOpen
            definitions={definitions}
            onPick={(path, name, type) => {
              pick(
                { kind: 'node_output', nodeId: source.id, path },
                name,
                type,
              );
            }}
          >
            <FirstFormFiles
              toRead={toRead}
              from={(form) =>
                form.origin === 'node_output' && form.step === source
              }
              onPick={(inserted, name) => {
                pick(inserted, name, 'file');
              }}
            />
          </StepFields>
        ))}
        {stepsFurtherBack(graph, nodeId, directIds).map((source) => (
          <StepFields
            key={source.id}
            step={source}
            startOpen={false}
            definitions={definitions}
            onPick={(path, name, type) => {
              const expression = sourceReference({
                kind: 'node_output',
                nodeId: source.id,
                path,
              });
              if (expression !== undefined)
                pick({ kind: 'expression', expression }, name, type);
            }}
          />
        ))}
        {variableScope === undefined ? null : (
          <li>
            <VariablePicker
              scope={variableScope}
              onChoose={(name) => {
                pick(
                  { kind: 'workspace_variable', name },
                  name.toLowerCase(),
                  undefined,
                );
              }}
            />
          </li>
        )}
        <RunInputChoices
          definitions={definitions}
          toRead={toRead}
          onPick={pick}
        />
      </ul>
      {direct.length === 0 && failureSource === undefined ? (
        <p className="mt-3 text-xs text-subtle-foreground">
          Link a step into this one to use its output here.
        </p>
      ) : null}
    </>
  );
}

/**
 * The engine hands a step only its direct links as `node_output`; further
 * back it reads the same output through an expression. A trigger's output is
 * the run input, which has its own section.
 */
function stepsFurtherBack(
  graph: GraphLevel,
  nodeId: string,
  directIds: ReadonlySet<string>,
): GraphLevel['nodes'] {
  return upstreamStepIds(graph, nodeId).flatMap((id) => {
    const step = graph.nodes.find((node) => node.id === id);
    return step === undefined ||
      directIds.has(id) ||
      isWorkflowTriggerDefinition(step.definition)
      ? []
      : [step];
  });
}

/** A trigger returns what it received, so its output shows the run's input. */
function RunInputChoices({
  definitions,
  toRead,
  onPick: pick,
}: Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  toRead: ReturnType<typeof formFilesToRead>;
  onPick: InsertPick;
}>) {
  const triggers = useEditorStore((state) => state.graph).nodes.filter((node) =>
    isWorkflowTriggerDefinition(node.definition),
  );
  const pickField: FieldPick = (path, name, type) => {
    pick({ kind: 'run_input', path }, name, type);
  };
  const files = (
    <FirstFormFiles
      toRead={toRead}
      from={(form) => form.origin === 'run_input'}
      onPick={(source, name) => {
        pick(source, name, 'file');
      }}
    />
  );
  if (triggers.length === 0)
    return (
      <li>
        <p className="text-[0.8rem] font-semibold">Run input</p>
        <FieldList fields={[]} wholeLabel="Whole input" onPick={pickField}>
          {files}
        </FieldList>
      </li>
    );
  return triggers.map((trigger, index) => (
    <StepFields
      key={`run-input:${trigger.id}`}
      step={trigger}
      title="Run input"
      wholeLabel="Whole input"
      // With two triggers the input is one or the other, so the second waits
      // to be asked for.
      startOpen={index === 0}
      definitions={definitions}
      onPick={pickField}
    >
      {index === 0 ? files : null}
    </StepFields>
  ));
}
