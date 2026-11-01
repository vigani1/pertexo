import { VariablePicker } from '@/features/workspace-variables/picker.public';
import {
  callbackTargetNodes,
  WORKFLOW_FAILURE_PORT,
  WORKFLOW_FAILURE_FIELDS,
} from '@pertexo/workflow-model';
import { StatusGlyph } from '@/components/ui/status';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import { DatabaseIcon } from 'lucide-react';
import { useState } from 'react';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { findDefinition } from '../../../../model/graph/adapter';
import type { GraphLevel } from '../../../../model/graph/scopes';
import { directPredecessorOptions } from '../../../../model/inspector/input-mappings/draft';
import { formFilesToRead } from '../../../../model/inspector/input-mappings/form-files';
import {
  CallbackInputChoices,
  FieldList,
  FirstFormFiles,
  LoopInputChoices,
  NodeOutputChoices,
} from './choices';
import type { InsertedSource } from '../../../../model/inspector/input-mappings/reference';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';

/**
 * "Insert data": inside a For each body, the item it runs for; the output
 * fields of steps linked right before this one (from their output
 * schema); and the run input. A step that reads a file is also offered the
 * first file each form question received. Picking one fills the input row
 * you were editing, or adds a row named after the field.
 */
export function InsertDataPicker({
  graph,
  variableScope,
  nodeId,
  loopPorts,
  definitions,
  disabled,
  onInsert,
  allowFailure = true,
  workflow,
}: Readonly<{
  /** The level the step is on: the workflow, or the body it's in. */
  allowFailure?: boolean;
  graph: GraphLevel;
  variableScope?: WorkspaceApiScope;
  nodeId: string;
  /** The body's inputs when the step is inside a For each; else empty. */
  loopPorts: readonly string[];
  definitions: readonly NodeDefinitionCatalogItem[];
  disabled: boolean;
  onInsert: (source: InsertedSource, fieldName: string) => void;
  /** The whole workflow, whose Form's files a step that reads a file is offered. */
  workflow?: GraphLevel;
}>) {
  const [open, setOpen] = useState(false);
  const sourceIds = new Set(
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
  const sources = graph.nodes.filter((node) => sourceIds.has(node.id));
  const toRead =
    workflow === undefined
      ? undefined
      : formFilesToRead(workflow, graph, nodeId, definition?.inputSchema);
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
            ? 'The item this body runs for, steps linked right before this one, and the run’s input.'
            : 'Steps linked right before this one, and the run’s input.'}
        </PopoverDescription>
        <ul className="mt-3 flex max-h-72 flex-col gap-3 overflow-y-auto">
          <LoopInputChoices loopPorts={loopPorts} onPick={pick} />
          {failureSource === undefined ? null : (
            <li>
              <p className="flex items-center gap-2 text-[0.8rem] font-semibold">
                <StatusGlyph tone="failure" />
                Source failure
              </p>
              <FieldList
                wholeLabel="All safe failure fields"
                fields={WORKFLOW_FAILURE_FIELDS.map((key) => ({ key }))}
                onPick={(path, name) => {
                  pick(
                    { kind: 'node_failure', nodeId: failureSource, path },
                    name || 'failure',
                  );
                }}
              />
            </li>
          )}
          {callbackTargets.map((target) => (
            <CallbackInputChoices
              key={`callback:${target.id}`}
              target={target}
              onPick={pick}
            />
          ))}
          {sources.map((source) => (
            <NodeOutputChoices
              key={source.id}
              source={source}
              definitions={definitions}
              onPick={pick}
            >
              <FirstFormFiles
                toRead={toRead}
                from={(form) =>
                  form.origin === 'node_output' && form.step === source
                }
                onPick={pick}
              />
            </NodeOutputChoices>
          ))}
          {variableScope === undefined ? null : (
            <li>
              <VariablePicker
                scope={variableScope}
                onChoose={(name) => {
                  pick(
                    { kind: 'workspace_variable', name },
                    name.toLowerCase(),
                  );
                }}
              />
            </li>
          )}
          <li>
            <p className="text-[0.8rem] font-semibold">Run input</p>
            <FieldList
              fields={[]}
              wholeLabel="Whole input"
              onPick={(path, name) => {
                pick({ kind: 'run_input', path }, name);
              }}
            >
              <FirstFormFiles
                toRead={toRead}
                from={(form) => form.origin === 'run_input'}
                onPick={pick}
              />
            </FieldList>
          </li>
        </ul>
        {sources.length === 0 && failureSource === undefined ? (
          <p className="mt-3 text-xs text-subtle-foreground">
            Link a step into this one to use its output here.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
