import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import { useReactFlow } from '@xyflow/react';
import type { RefObject } from 'react';
import type { EditorStore } from './editor.store';
import { addDefinitionNode, freePosition } from './graph-commands';
import { findDefinitionByIdentity } from './step-catalog';

type Position = Readonly<{ x: number; y: number }>;

/** Half a step card, so a placed step is centred where you look. */
const CARD_HALF = Object.freeze({ x: 112, y: 32 });

/**
 * Places new steps where people can see them: clicking an add-step item
 * drops it at the centre of the visible canvas (nudged off any step already
 * there), and dragging drops it under the pointer.
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

  function place(definition: NodeDefinitionCatalogItem, position: Position) {
    const state = store.getState();
    if (state.saveStatus === 'conflict') return;
    const id = crypto.randomUUID();
    state.transact(
      addDefinitionNode(
        state.graph,
        definition,
        freePosition(state.graph, position),
        id,
      ),
    );
    onPlaced(id);
  }

  return {
    addAtCentre: (definition: NodeDefinitionCatalogItem) => {
      place(definition, viewportCentre());
    },
    addAt: (identity: string, position: Position) => {
      const definition = findDefinitionByIdentity(definitions, identity);
      if (definition !== undefined)
        place(definition, {
          x: position.x - CARD_HALF.x,
          y: position.y - CARD_HALF.y,
        });
    },
  } as const;
}
