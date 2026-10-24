import { inspectWorkflowFailureRoutes } from '@pertexo/workflow-model';
import { useNotifications } from '@/components/ui/use-notifications';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import { useReactFlow } from '@xyflow/react';
import type { RefObject } from 'react';
import {
  cardSize,
  shownLevel,
  STEP_CARD,
} from '../../model/graph/for-each-body-layout';
import type { EditorStore } from '../../model/state/store';
import {
  addBodyStep,
  addDefinitionNode,
  addStepAfter,
  freePosition,
  positionAfter,
} from '../../model/graph/commands';
import { loopOf, scopeOf, type ScopePath } from '../../model/graph/scopes';
import { findDefinition } from '../../model/graph/adapter';
import { openOutputPort } from '../../model/quick-add';
import { shownPorts } from '../../model/step-card';
import { findDefinitionByIdentity } from '../../model/step-catalog';
import type { QuickAddTarget } from './use-quick';

type Position = Readonly<{ x: number; y: number }>;

/** Half a step card, so a placed step is centred where you look. */
const CARD_HALF = Object.freeze({
  x: STEP_CARD.width / 2,
  y: STEP_CARD.height / 2,
});

/**
 * Places new steps where people can see them: clicking an add-step item
 * follows a selected step to its right when their ports allow it, otherwise
 * drops at the visible centre. Dragging drops under the pointer, and quick add puts it where
 * it was asked for, already linked, inside a For each body when that's
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
  const { screenToFlowPosition, getInternalNode } = useReactFlow();
  const notifications = useNotifications();

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
      next = addBodyStep({
        graph,
        loopId,
        definition,
        position: at,
        ids,
        from,
      });
    else if (from !== undefined)
      next = addStepAfter({ graph, definition, position: at, from, ids });
    else next = addDefinitionNode(graph, definition, at, ids.nodeId);
    if (next === null) return;
    const failureCheck = inspectWorkflowFailureRoutes(next);
    if (failureCheck.kind === 'invalid') {
      notifications.error({
        title: 'Cannot link this step',
        description: failureCheck.message,
      });
      return;
    }
    state.transact(next);
    onPlaced(ids.nodeId);
  }

  function addOnCanvas(
    definition: NodeDefinitionCatalogItem,
    position: Position,
  ) {
    place(definition, { from: undefined, loopId: undefined, position });
  }

  function afterSelection(
    definition: NodeDefinitionCatalogItem,
  ): QuickAddTarget | undefined {
    const { graph, selectedNodeId } = store.getState();
    if (selectedNodeId === null || definition.ports.inputs.length === 0)
      return undefined;
    const scope = scopeOf(graph, selectedNodeId);
    const level = scope === undefined ? undefined : shownLevel(graph, scope);
    const source = level?.nodes.find(({ id }) => id === selectedNodeId);
    if (source === undefined || level === undefined || scope === undefined)
      return undefined;
    const port = openOutputPort(
      level,
      source.id,
      shownPorts(source, findDefinition(definitions, source), level, 'outputs'),
    );
    if (port === undefined) return undefined;
    return {
      from: { nodeId: source.id, port },
      loopId: loopOf(scope),
      position: positionAfter(
        source,
        getInternalNode(source.id)?.measured.width ?? cardSize(source).width,
      ),
    };
  }

  return {
    addAtCentre: (definition: NodeDefinitionCatalogItem) => {
      const target = afterSelection(definition);
      if (target === undefined) addOnCanvas(definition, viewportCentre());
      else place(definition, target);
    },
    addAt: (identity: string, position: Position) => {
      const definition = findDefinitionByIdentity(definitions, identity);
      if (definition !== undefined)
        addOnCanvas(definition, {
          x: position.x - CARD_HALF.x,
          y: position.y - CARD_HALF.y,
        });
    },
    /** Adds a step where quick add asked for it, linked as asked. */
    addFromQuickAdd: place,
  } as const;
}
