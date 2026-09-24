import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { ReactNode } from 'react';
import { CopyPlusIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { describeStep } from '@/features/catalog/presentation.public';
import { useEditorStore } from '../../model/editor-store-context';
import { findDefinition } from '../../model/graph-adapter';
import type { EditorFocusTarget } from '../../use-editor-actions';
import type { InspectorTab } from '../../use-inspector-navigation';
import { NodeInspector, type NodeInspectorActions } from './node-inspector';

/**
 * What the inspector lens shows for the current selection: one step's
 * inspector, a summary for several steps, or a hint when nothing is picked.
 */
export function InspectorPanel({
  definitions,
  connections,
  workspaceId,
  editable,
  scratchVersion,
  tab,
  onTabChange,
  focusTarget,
  renderTest,
  actions,
  onDuplicateSelection,
  onDeleteSelection,
}: Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  connections: readonly ConnectionResponse[];
  workspaceId: string;
  editable: boolean;
  scratchVersion: number;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  focusTarget:
    (EditorFocusTarget & Readonly<{ requestId: number }>) | undefined;
  renderTest: (nodeId: string, stepSideEffect: string | undefined) => ReactNode;
  actions: NodeInspectorActions;
  onDuplicateSelection: () => void;
  onDeleteSelection: () => void;
}>) {
  const graph = useEditorStore((state) => state.graph);
  const selectedNodeId = useEditorStore((state) => state.selectedNodeId);
  const selectedCount = useEditorStore((state) => state.selectedNodeIds.length);
  const node = graph.nodes.find((candidate) => candidate.id === selectedNodeId);
  if (node !== undefined) {
    const definition = findDefinition(definitions, node);
    return (
      <NodeInspector
        key={`${node.id}:${String(scratchVersion)}`}
        node={node}
        graph={graph}
        definition={definition}
        definitions={definitions}
        connections={connections}
        workspaceId={workspaceId}
        editable={editable}
        tab={tab}
        onTabChange={onTabChange}
        focusTarget={focusTarget}
        testPanel={renderTest(
          node.id,
          describeStep(node.definition.key).sideEffect,
        )}
        actions={actions}
      />
    );
  }
  if (selectedCount > 1)
    return (
      <div className="flex flex-col gap-3 p-4">
        <h2 className="font-heading text-lg font-semibold">
          {selectedCount} steps selected
        </h2>
        <p className="text-sm text-muted-foreground">
          Select one step to see its setup.
        </p>
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onDuplicateSelection}
            >
              <CopyPlusIcon data-icon="inline-start" />
              Duplicate
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={onDeleteSelection}
            >
              <Trash2Icon data-icon="inline-start" />
              Delete
            </Button>
          </div>
        ) : null}
      </div>
    );
  return (
    <div className="p-4">
      <h2 className="font-heading text-lg font-semibold">No step selected</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Select a step on the canvas to set it up, map its inputs and test it.
      </p>
    </div>
  );
}
