import type { ReactNode } from 'react';
import { describeStep } from '@/features/catalog/presentation.public';
import { useEditorStore } from '../../model/state/context';

import { locateStep } from '../../model/graph/scopes';

import {
  NodeInspector,
  type NodeInspectorActions,
  type NodeInspectorView,
} from './node';

function stepName(
  node: Readonly<{ label?: string | undefined; definition: { key: string } }>,
) {
  const label = node.label?.trim();
  return label === undefined || label === ''
    ? describeStep(node.definition.key).name
    : label;
}

/**
 * What the inspector lens shows for the current selection: one step's
 * inspector, a summary for several steps, or a hint when nothing is picked.
 */
export function InspectorPanel({
  view,
  renderTest,
  renderFailureSetup,
  renderRuns,
  actions,
}: Readonly<{
  view: NodeInspectorView & Readonly<{ scratchVersion: number }>;
  renderFailureSetup?: (
    node: Parameters<typeof NodeInspector>[0]['node'],
  ) => ReactNode;
  renderTest: (nodeId: string, stepSideEffect: string | undefined) => ReactNode;
  renderRuns?: (nodeId: string, stepLabel: string) => ReactNode;
  actions: NodeInspectorActions;
}>) {
  const { scratchVersion } = view;
  const graph = useEditorStore((state) => state.graph);
  const selectedNodeId = useEditorStore((state) => state.selectedNodeId);
  const selectedCount = useEditorStore((state) => state.selectedNodeIds.length);
  const step =
    selectedNodeId === null ? undefined : locateStep(graph, selectedNodeId);
  if (step !== undefined) {
    const { node } = step;
    return (
      <NodeInspector
        key={`${node.id}:${String(scratchVersion)}`}
        node={node}
        graph={step.level}
        loopPorts={step.loopPorts}
        view={view}
        panels={{
          testPanel: renderTest(
            node.id,
            describeStep(node.definition.key).sideEffect,
          ),
          runsPanel: renderRuns?.(node.id, stepName(node)),
          failureSetup: renderFailureSetup?.(node),
        }}
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
