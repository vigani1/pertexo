import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { Connection } from '@xyflow/react';
import { PlusIcon } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { useNotifications } from '@/components/ui/use-notifications';
import { useEditorStoreApi } from '../../model/editor-store-context';
import type { GraphLevel, WorkflowNode } from '../../model/graph-scopes';
import {
  directPredecessorOptions,
  inputKeySuggestions,
  nodeUsesRunInputDirectly,
  type InputMappingDraftRow,
} from '../../model/input-mappings';
import { useLiveMappings } from '../../use-live-mappings';
import { IncomingConnections } from './incoming-connections';
import {
  InsertDataPicker,
  type InsertedSource,
} from './input-mappings/insert-data-picker';
import { MappingRow } from './input-mappings/mapping-row';
import type { NodeFormApi } from '../../model/node-form';

/**
 * Inputs: each row reads `field ← source`. Rows apply as soon as they're
 * complete; removing one is an ordinary edit, so ⌘Z brings it back. Inside
 * a For each body, rows can also read the item the body runs for.
 */
export function InputsTab({
  node,
  graph,
  loopPorts,
  definition,
  definitions,
  form,
  onConnect,
  onRemoveEdge,
}: Readonly<{
  node: WorkflowNode;
  /** The level the step is on: the workflow, or the body it's in. */
  graph: GraphLevel;
  /** The body's inputs when the step is inside a For each; else empty. */
  loopPorts: readonly string[];
  definition: NodeDefinitionCatalogItem | undefined;
  definitions: readonly NodeDefinitionCatalogItem[];
  form: NodeFormApi;
  onConnect: (connection: Connection) => void;
  onRemoveEdge: (edgeId: string) => void;
}>) {
  const activeRowId = useRef<string | undefined>(undefined);
  const store = useEditorStoreApi();
  const notifications = useNotifications();
  const mappings = useLiveMappings({
    node,
    graph,
    loopPorts,
    commit: (inputMappings) => {
      form.commit({ inputMappings }, `${node.id}:inputs`);
    },
    reportScratch: form.reportScratch,
  });
  const editable = form.editable && definition !== undefined;
  const suggestions = inputKeySuggestions(definition?.inputSchema);
  const predecessors = directPredecessorOptions(graph, node.id);
  const connections = (
    <IncomingConnections
      node={node}
      graph={graph}
      definitions={definitions}
      editable={form.editable}
      onConnect={onConnect}
      onRemoveEdge={onRemoveEdge}
    />
  );
  if (nodeUsesRunInputDirectly(node.definition))
    return (
      <div className="flex flex-col gap-5">
        <p className="text-sm text-muted-foreground">
          This trigger receives the run’s input directly, so it has no inputs to
          map.
        </p>
        {connections}
      </div>
    );

  function insert(source: InsertedSource, fieldName: string) {
    const active = mappings.rows.find((row) => row.id === activeRowId.current);
    const withSource = (
      base: Pick<InputMappingDraftRow, 'id' | 'destinationKey'>,
    ): InputMappingDraftRow => ({ ...base, ...source });
    if (active !== undefined) {
      mappings.changeRow(
        withSource({ id: active.id, destinationKey: active.destinationKey }),
      );
      return;
    }
    const taken = mappings.rows.some((row) => row.destinationKey === fieldName);
    activeRowId.current = mappings.addRow((id) =>
      withSource({ id, destinationKey: taken ? '' : fieldName }),
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Inputs" className="flex flex-col gap-3">
        {mappings.rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-white/10 p-3 text-sm text-muted-foreground">
            No input mappings yet. Add a value, part of the run input, or the
            output of a step connected before this one.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {mappings.rows.map((row) => (
              <MappingRow
                key={row.id}
                nodeId={node.id}
                row={row}
                suggestions={suggestions}
                predecessors={predecessors}
                loopPorts={loopPorts}
                errors={mappings.errors[row.id]}
                disabled={!editable}
                onChange={mappings.changeRow}
                onRemove={() => {
                  const before = store.getState().generation;
                  mappings.removeRow(row.id);
                  const after = store.getState().generation;
                  if (after === before) return;
                  notifications.undo({
                    title:
                      row.destinationKey === ''
                        ? 'Input removed'
                        : `Removed the “${row.destinationKey}” input`,
                    onUndo: () => {
                      if (store.getState().generation === after)
                        store.getState().undo();
                    },
                  });
                }}
                onFocusRow={() => {
                  activeRowId.current = row.id;
                }}
              />
            ))}
          </ol>
        )}
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                activeRowId.current = mappings.addRow();
              }}
            >
              <PlusIcon data-icon="inline-start" />
              Add input
            </Button>
            <InsertDataPicker
              graph={graph}
              nodeId={node.id}
              loopPorts={loopPorts}
              definitions={definitions}
              disabled={!editable}
              onInsert={insert}
            />
          </div>
        ) : null}
      </section>
      {connections}
    </div>
  );
}
