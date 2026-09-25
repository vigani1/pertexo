import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import { useReactFlow } from '@xyflow/react';
import type { RefObject } from 'react';
import { shownLevel, STEP_CARD } from './model/body-layout';
import type { EditorStore } from './model/editor.store';
import {
  addBodyStep,
  addDefinitionNode,
  addStepAfter,
  freePosition,
} from './model/graph-commands';
import { scopeOf, type ScopePath } from './model/graph-scopes';
import { findDefinitionByIdentity } from './model/step-catalog';
import type { QuickAddTarget } from './use-quick-add';

type Position = Readonly<{ x: number; y: number }>;

/** Half a step card, so a placed step is centred where you look. */
const CARD_HALF = Object.freeze({
  x: STEP_CARD.width / 2,
  y: STEP_CARD.height / 2,
});

/**
 * Places new steps where people can see them: clicking an add-step item
 * drops it at the centre of the visible canvas (nudged off any step already
 * there), dragging drops it under the pointer, and quick add puts it where
 * it was asked for, already connected, inside a For each body when that's
 * where it was asked for.
 */
export function useStepPlacement({
  store,
  definitions,
  canvasRef,
  onPlaced,
}: Readonly<{
  store: EditorStore;
  definitions: readonly NodeDefinitionCatalogItem[];
  canvasRef: RefObject<HTMLDivElement | null>;
  onPlaced: (nodeId: string) => void;
}>) {
  const { screenToFlowPosition } = useReactFlow();

  function viewportCentre(): Position {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0 || rect.height === 0)
      return { x: 0, y: 0 };
    const point = screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    return { x: point.x - CARD_HALF.x, y: point.y - CARD_HALF.y };
  }

  function place(
    definition: NodeDefinitionCatalogItem,
    target: QuickAddTarget,
  ) {
    const state = store.getState();
    if (state.saveStatus === 'conflict') return;
    const { graph } = state;
    const { from, loopId } = target;
    let scope: ScopePath = [];
    if (loopId !== undefined)
      scope = [...(scopeOf(graph, loopId) ?? []), loopId];
    else if (from !== undefined) scope = scopeOf(graph, from.nodeId) ?? [];
    const level = shownLevel(graph, scope) ?? { nodes: [], edges: [] };
    const at = freePosition(level, target.position);
    const ids = { nodeId: crypto.randomUUID(), edgeId: crypto.randomUUID() };
    let next;
    if (loopId !== undefined)
      next = addBodyStep(graph, loopId, definition, at, ids, from);
    else if (from !== undefined)
      next = addStepAfter(graph, definition, at, from, ids);
    else next = addDefinitionNode(graph, definition, at, ids.nodeId);
    if (next === null) return;
    state.transact(next);
    onPlaced(ids.nodeId);
  }

  function addOnCanvas(
    definition: NodeDefinitionCatalogItem,
    position: Position,
  ) {
    place(definition, { from: undefined, loopId: undefined, position });
  }

  return {
    addAtCentre: (definition: NodeDefinitionCatalogItem) => {
      addOnCanvas(definition, viewportCentre());
    },
    addAt: (identity: string, position: Position) => {
      const definition = findDefinitionByIdentity(definitions, identity);
      if (definition !== undefined)
        addOnCanvas(definition, {
          x: position.x - CARD_HALF.x,
          y: position.y - CARD_HALF.y,
        });
    },
    /** Adds a step where quick add asked for it, connected as asked. */
    addFromQuickAdd: place,
  } as const;
}
