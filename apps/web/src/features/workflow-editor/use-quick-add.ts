import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import { useReactFlow } from '@xyflow/react';
import { useState } from 'react';
import { shownLevel, STEP_CARD, toBodyPosition } from './model/body-layout';
import type { EditorStore } from './model/editor.store';
import { findDefinition } from './model/graph-adapter';
import { positionAfter, type PortRef } from './model/graph-commands';
import { levelSinks } from './model/graph-order';
import {
  findStep,
  isForEach,
  loopOf,
  scopeOf,
  type GraphLevel,
} from './model/graph-scopes';
import { openOutputPort } from './model/quick-add';

type Point = Readonly<{ x: number; y: number }>;

export type QuickAddRequest = Readonly<{
  /** The step the new one follows, and the output it connects from. */
  from: PortRef | undefined;
  /** That step's outputs, so people can still pick another one. */
  outputs: readonly string[];
  /** The For each whose body gets the step; otherwise `from`'s level. */
  loopId: string | undefined;
  /** Where the new step goes, on its own level (its top left corner). */
  position: Point;
  /** Where the lens opens, in viewport coordinates. */
  anchor: Point;
  /** What opened it, to return focus to if it's still there. */
  returnFocus: HTMLElement | null;
}>;

/** What quick add hands on once a step is chosen. */
export type QuickAddTarget = Pick<
  QuickAddRequest,
  'from' | 'loopId' | 'position'
>;

/**
 * Quick add: which step a new one will follow, from which output, and where
 * it lands. Dropping a connection on empty canvas asks at the drop point;
 * “Add step after” asks beside the step; a For each's “Add step” asks for
 * its body, after the step that ends it. A new step always joins the level
 * of the step it follows, so a body step's quick add stays in its body.
 * Choosing hands the result to `onAdd`, which adds (and connects) it as one
 * undoable change.
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
    target: QuickAddTarget,
  ) => void;
}>) {
  const { screenToFlowPosition, flowToScreenPosition, getInternalNode } =
    useReactFlow();
  const [request, setRequest] = useState<QuickAddRequest>();

  function outputsOf(nodeId: string): readonly string[] {
    const node = findStep(store.getState().graph, nodeId);
    if (node === undefined) return [];
    return findDefinition(definitions, node)?.ports.outputs ?? [];
  }

  /** A step on its level as drawn now, and its card's size. */
  function shownStep(level: GraphLevel, nodeId: string) {
    const node = level.nodes.find(({ id }) => id === nodeId);
    const measured = getInternalNode(nodeId)?.measured;
    return node === undefined
      ? undefined
      : {
          node,
          width: measured?.width ?? STEP_CARD.width,
          height: measured?.height ?? STEP_CARD.height,
        };
  }

  function openAtDrop(from: PortRef, point: Point) {
    const flow = screenToFlowPosition(point);
    const corner = { x: flow.x, y: flow.y - STEP_CARD.height / 2 };
    const loopId = loopOf(scopeOf(store.getState().graph, from.nodeId) ?? []);
    const container =
      loopId === undefined
        ? undefined
        : getInternalNode(loopId)?.internals.positionAbsolute;
    setRequest({
      from,
      outputs: outputsOf(from.nodeId),
      loopId: undefined,
      position:
        container === undefined
          ? corner
          : toBodyPosition({
              x: corner.x - container.x,
              y: corner.y - container.y,
            }),
      anchor: point,
      returnFocus: null,
    });
  }

  function openAfter(nodeId: string, returnFocus: HTMLElement | null) {
    const graph = store.getState().graph;
    const level = shownLevel(graph, scopeOf(graph, nodeId) ?? []);
    const outputs = outputsOf(nodeId);
    const step = level === undefined ? undefined : shownStep(level, nodeId);
    const port =
      level === undefined ? undefined : openOutputPort(level, nodeId, outputs);
    if (step === undefined || port === undefined) return;
    const absolute =
      getInternalNode(nodeId)?.internals.positionAbsolute ?? step.node.position;
    setRequest({
      from: { nodeId, port },
      outputs,
      loopId: undefined,
      position: positionAfter(step.node, step.width),
      anchor: flowToScreenPosition({
        x: absolute.x + step.width,
        y: absolute.y + step.height / 2,
      }),
      returnFocus,
    });
  }

  /** A body's one last step, when it has an output a new step can follow. */
  function afterLastStep(body: GraphLevel) {
    const [last, ...others] = levelSinks(body);
    const step =
      last === undefined || others.length > 0
        ? undefined
        : shownStep(body, last);
    if (step === undefined) return undefined;
    const outputs = outputsOf(step.node.id);
    const port = openOutputPort(body, step.node.id, outputs);
    return port === undefined
      ? undefined
      : {
          from: { nodeId: step.node.id, port },
          outputs,
          position: positionAfter(step.node, step.width),
        };
  }

  function openInBody(loopId: string, returnFocus: HTMLElement) {
    const graph = store.getState().graph;
    const loop = findStep(graph, loopId);
    if (loop === undefined || !isForEach(loop)) return;
    const body = shownLevel(graph, [...(scopeOf(graph, loopId) ?? []), loopId]);
    const after = body === undefined ? undefined : afterLastStep(body);
    const rect = returnFocus.getBoundingClientRect();
    setRequest({
      from: after?.from,
      outputs: after?.outputs ?? [],
      loopId,
      position: after?.position ?? { x: 0, y: 0 },
      anchor: { x: rect.right, y: rect.top + rect.height / 2 },
      returnFocus,
    });
  }

  function choose(definition: NodeDefinitionCatalogItem) {
    if (request === undefined) return;
    setRequest(undefined);
    onAdd(definition, request);
  }

  return {
    request,
    openAtDrop,
    openAfter,
    openInBody,
    choosePort: (port: string) => {
      setRequest(
        (current) =>
          current && {
            ...current,
            from:
              current.from === undefined
                ? undefined
                : { ...current.from, port },
          },
      );
    },
    choose,
    close: () => {
      setRequest(undefined);
    },
  } as const;
}
