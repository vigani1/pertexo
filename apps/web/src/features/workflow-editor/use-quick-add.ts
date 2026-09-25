import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import { useReactFlow } from '@xyflow/react';
import { useState } from 'react';
import type { EditorStore } from './model/editor.store';
import { findDefinition } from './model/graph-adapter';
import { positionAfter, STEP_CARD, type PortRef } from './model/graph-commands';
import { openOutputPort } from './model/quick-add';

type Point = Readonly<{ x: number; y: number }>;

export type QuickAddRequest = Readonly<{
  /** The step the new one follows, and the output it connects from. */
  from: PortRef;
  /** That step's outputs, so people can still pick another one. */
  outputs: readonly string[];
  /** Where the new step goes on the canvas (its top left corner). */
  position: Point;
  /** Where the lens opens, in viewport coordinates. */
  anchor: Point;
  /** What opened it, to return focus to if it's still there. */
  returnFocus: HTMLElement | null;
}>;

/**
 * Quick add: which step a new one will follow, from which output, and where
 * it lands. Dropping a connection on empty canvas asks at the drop point;
 * “Add step after” asks beside the step. Choosing hands the result to
 * `onAdd`, which adds and connects it as one undoable change.
 */
export function useQuickAdd({
  store,
  definitions,
  onAdd,
}: Readonly<{
  store: EditorStore;
  definitions: readonly NodeDefinitionCatalogItem[];
  onAdd: (
    definition: NodeDefinitionCatalogItem,
    from: PortRef,
    position: Point,
  ) => void;
}>) {
  const { screenToFlowPosition, flowToScreenPosition, getInternalNode } =
    useReactFlow();
  const [request, setRequest] = useState<QuickAddRequest>();

  function outputsOf(nodeId: string): readonly string[] {
    const node = store.getState().graph.nodes.find(({ id }) => id === nodeId);
    if (node === undefined) return [];
    return findDefinition(definitions, node)?.ports.outputs ?? [];
  }

  function openAtDrop(from: PortRef, point: Point) {
    const flow = screenToFlowPosition(point);
    setRequest({
      from,
      outputs: outputsOf(from.nodeId),
      position: { x: flow.x, y: flow.y - STEP_CARD.height / 2 },
      anchor: point,
      returnFocus: null,
    });
  }

  function openAfter(nodeId: string, returnFocus: HTMLElement | null) {
    const graph = store.getState().graph;
    const node = graph.nodes.find(({ id }) => id === nodeId);
    const outputs = outputsOf(nodeId);
    const port = openOutputPort(graph, nodeId, outputs);
    if (node === undefined || port === undefined) return;
    const measured = getInternalNode(nodeId)?.measured;
    const width = measured?.width ?? STEP_CARD.width;
    const height = measured?.height ?? STEP_CARD.height;
    setRequest({
      from: { nodeId, port },
      outputs,
      position: positionAfter(node, width),
      anchor: flowToScreenPosition({
        x: node.position.x + width,
        y: node.position.y + height / 2,
      }),
      returnFocus,
    });
  }

  function choose(definition: NodeDefinitionCatalogItem) {
    if (request === undefined) return;
    setRequest(undefined);
    onAdd(definition, request.from, request.position);
  }

  return {
    request,
    openAtDrop,
    openAfter,
    choosePort: (port: string) => {
      setRequest(
        (current) => current && { ...current, from: { ...current.from, port } },
      );
    },
    choose,
    close: () => {
      setRequest(undefined);
    },
  } as const;
}
