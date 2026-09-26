import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { ReactNode } from 'react';
import { describeStep } from '@/features/catalog/presentation.public';
import { useEditorStore } from '../../model/editor-store-context';
import { findDefinition } from '../../model/graph-adapter';
import { locateStep } from '../../model/graph-scopes';
import type { EditorFocusTarget } from '../../use-editor-actions';
import type { InspectorTab } from '../../use-inspector-navigation';
import { NodeInspector, type NodeInspectorActions } from './node-inspector';
import type { ChannelLookupScope } from './slack-channel-field';

/**
 * What the inspector lens shows for the current selection: one step's
 * inspector, a summary for several steps, or a hint when nothing is picked.
 */
export function InspectorPanel({
  definitions,
  connections,
  channelLookup,
  editable,
  scratchVersion,
  tab,
  onTabChange,
  focusTarget,
  renderTest,
  actions,
}: Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  connections: readonly ConnectionResponse[];
  channelLookup: ChannelLookupScope;
  editable: boolean;
  scratchVersion: number;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  focusTarget:
    (EditorFocusTarget & Readonly<{ requestId: number }>) | undefined;
  renderTest: (nodeId: string, stepSideEffect: string | undefined) => ReactNode;
  actions: NodeInspectorActions;
}>) {
  const graph = useEditorStore((state) => state.graph);
  const selectedNodeId = useEditorStore((state) => state.selectedNodeId);
  const selectedCount = useEditorStore((state) => state.selectedNodeIds.length);
  const step =
    selectedNodeId === null ? undefined : locateStep(graph, selectedNodeId);
  if (step !== undefined) {
    const { node } = step;
    const definition = findDefinition(definitions, node);
    return (
      <NodeInspector
        key={`${node.id}:${String(scratchVersion)}`}
        node={node}
        graph={step.level}
        loopPorts={step.loopPorts}
        definition={definition}
        definitions={definitions}
        connections={connections}
        channelLookup={channelLookup}
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
        {/* Duplicate and Delete live on the canvas bar beside the
            selection; saying so here beats a second copy of them. */}
        <p className="text-sm text-muted-foreground">
          Duplicate or delete them from the bar on the canvas, or select one
          step to see its setup.
        </p>
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
