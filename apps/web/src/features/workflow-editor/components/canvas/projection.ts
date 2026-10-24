import type { NodeChange } from '@xyflow/react';
import { useCallback, useMemo, useState } from 'react';
import { stepSampleBindings } from '@pertexo/workflow-model';
import { currentSampleState } from '@/features/workflow-publish/step-samples.public';
import type {
  StepSampleMetadata,
  NodeDefinitionCatalogItem,
} from '@pertexo/contracts';
import { levelPositions } from '../../model/graph/for-each-body-layout';
import { forEachBodyIssues } from '../../model/graph/for-each-body-rules';
import {
  projectWorkflowGraph,
  type CanvasDecorations,
  type WorkflowFlowNode,
} from '../../model/graph/adapter';
import { moveWorkflowNodes } from '../../model/graph/commands';
import { useEditorStore, useEditorStoreApi } from '../../model/state/context';

export type Position = Readonly<{ x: number; y: number }>;

type Size = Readonly<{ width: number; height: number }>;

export type CanvasOverlays = Pick<
  CanvasDecorations,
  | 'issuesByNode'
  | 'flowingEdgeIds'
  | 'weaveOrder'
  | 'testOutputBytes'
  | 'testStatuses'
>;

/**
 * The graph as React Flow draws it, and the node changes React Flow reports
 * back: drags move steps as one change when they end, selection goes
 * through the editor's guard, and measured sizes return with each
 * projection.
 */
export function useCanvasProjection({
  definitions,
  overlays,
  samples,
  editable,
  onSelectNodes,
}: Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  overlays: CanvasOverlays;
  samples: readonly StepSampleMetadata[] | undefined;
  editable: boolean;
  onSelectNodes: (nodeIds: readonly string[]) => void;
}>) {
  const store = useEditorStoreApi();
  const graph = useEditorStore((state) => state.graph);
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const selectedEdgeIds = useEditorStore((state) => state.selectedEdgeIds);
  const [dragPositions, setDragPositions] = useState<
    ReadonlyMap<string, Position>
  >(() => new Map());
  // React Flow marks its own copy of a node selected before asking us. When
  // the editor's guard declines a selection, fresh node objects re-sync it.
  const [selectionResync, setSelectionResync] = useState(0);
  // Measured sizes go back into every projection: React Flow's overview map
  // draws the nodes we pass it, and a node without a size isn't drawn.
  const [measuredSizes, setMeasuredSizes] = useState<ReadonlyMap<string, Size>>(
    () => new Map(),
  );

  const sampleStates = useMemo(() => {
    if (samples === undefined)
      return new Map<string, StepSampleMetadata['state']>();
    const bindings = stepSampleBindings(graph);
    return new Map(
      samples.map((sample) => [
        sample.nodeId,
        currentSampleState(sample, bindings.get(sample.nodeId)),
      ]),
    );
  }, [graph, samples]);
  const projection = useMemo(
    () =>
      projectWorkflowGraph(graph, definitions, {
        ...overlays,
        sampleStates,
        selectedNodeIds,
        selectedEdgeIds,
        dragPositions,
        bodyIssues: forEachBodyIssues(graph),
        measuredSizes,
      }),
    // selectionResync only forces fresh node objects for React Flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      definitions,
      dragPositions,
      graph,
      measuredSizes,
      overlays,
      sampleStates,
      selectedEdgeIds,
      selectedNodeIds,
      selectionResync,
    ],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<WorkflowFlowNode>[]) => {
      const moving = new Map<string, Position>();
      const settled = new Map<string, Position>();
      const sized = new Map<string, Size>();
      let selection: Set<string> | undefined;
      for (const change of changes) {
        if (change.type === 'dimensions') {
          if (change.dimensions !== undefined)
            sized.set(change.id, change.dimensions);
        } else if (change.type === 'select') {
          selection ??= new Set(store.getState().selectedNodeIds);
          if (change.selected) selection.add(change.id);
          else selection.delete(change.id);
        } else if (change.type === 'position' && editable) {
          const position = change.position ?? dragPositions.get(change.id);
          if (position === undefined) continue;
          if (change.dragging ?? false) moving.set(change.id, position);
          else settled.set(change.id, position);
        }
      }
      if (selection !== undefined) {
        const requested = [...selection];
        onSelectNodes(requested);
        const applied = new Set(store.getState().selectedNodeIds);
        if (
          applied.size !== requested.length ||
          requested.some((id) => !applied.has(id))
        )
          setSelectionResync((current) => current + 1);
      }
      if (sized.size > 0)
        setMeasuredSizes((current) => new Map([...current, ...sized]));
      if (moving.size > 0)
        setDragPositions((current) => new Map([...current, ...moving]));
      if (settled.size === 0) return;
      const state = store.getState();
      state.transact(
        moveWorkflowNodes(state.graph, levelPositions(state.graph, settled)),
        { coalesceKey: `move:${[...settled.keys()].join(',')}` },
      );
      setDragPositions((current) => {
        const next = new Map(current);
        for (const id of settled.keys()) next.delete(id);
        return next;
      });
    },
    [dragPositions, editable, onSelectNodes, store],
  );
  return { projection, onNodesChange } as const;
}
