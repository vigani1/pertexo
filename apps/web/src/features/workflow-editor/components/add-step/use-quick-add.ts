import { WORKFLOW_FAILURE_PORT } from '@pertexo/workflow-model';
import { canOwnFailureLink } from '../../model/failure-routing/eligibility';
import { failureLink } from '../../model/failure-routing/commands';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import { useReactFlow } from '@xyflow/react';
import { useState } from 'react';
import {
  shownLevel,
  cardSize,
  STEP_CARD,
  toBodyPosition,
} from '../../model/graph/for-each-body-layout';
import type { EditorStore } from '../../model/state/store';
import { findDefinition } from '../../model/graph/adapter';
import { positionAfter, type PortRef } from '../../model/graph/commands';
import { levelSinks } from '../../model/graph/order';
import {
  findStep,
  isForEach,
  loopOf,
  scopeOf,
  type GraphLevel,
} from '../../model/graph/scopes';
import { openOutputPort } from '../../model/quick-add';
import { shownPorts } from '../../model/step-card';

type Point = Readonly<{ x: number; y: number }>;

export type QuickAddRequest = Readonly<{
  /** The step the new one follows, and the output it links from. */
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
 * it lands. Dropping a link on empty canvas asks at the drop point;
 * “Add step after” asks beside the step; a For each's “Add step” asks for
 * its body, after the step that ends it. A new step always joins the level
 * of the step it follows, so a body step's quick add stays in its body.
 * Choosing hands the result to `onAdd`, which adds (and links) it as one
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
      outputs: outputsOf({ store, definitions, nodeId: from.nodeId }),
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
    const outputs = outputsOf({ store, definitions, nodeId });
    const step =
      level === undefined
        ? undefined
        : shownStep({ level, nodeId, getInternalNode });
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

  function openFailure(nodeId: string, returnFocus: HTMLElement) {
    const graph = store.getState().graph;
    if (
      !canOwnFailureLink(graph, nodeId) ||
      failureLink(graph, nodeId) !== undefined
    )
      return;
    const step = shownStep({ level: graph, nodeId, getInternalNode });
    if (step === undefined) return;
    const absolute =
      getInternalNode(nodeId)?.internals.positionAbsolute ?? step.node.position;
    setRequest({
      from: { nodeId, port: WORKFLOW_FAILURE_PORT },
      outputs: [WORKFLOW_FAILURE_PORT],
      loopId: undefined,
      position: {
        ...positionAfter(step.node, step.width),
        y: step.node.position.y + step.height + 32,
      },
      anchor: flowToScreenPosition({
        x: absolute.x + step.width,
        y: absolute.y + step.height,
      }),
      returnFocus,
    });
  }

  function openInBody(loopId: string, returnFocus: HTMLElement) {
    const graph = store.getState().graph;
    const loop = findStep(graph, loopId);
    if (loop === undefined || !isForEach(loop)) return;
    const body = shownLevel(graph, [...(scopeOf(graph, loopId) ?? []), loopId]);
    const after =
      body === undefined
        ? undefined
        : afterLastStep({ body, store, definitions, getInternalNode });
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
    openFailure,
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

function outputsOf({
  store,
  definitions,
  nodeId,
}: Readonly<{
  store: EditorStore;
  definitions: readonly NodeDefinitionCatalogItem[];
  nodeId: string;
}>): readonly string[] {
  const graph = store.getState().graph;
  const level = shownLevel(graph, scopeOf(graph, nodeId) ?? []);
  const node = level?.nodes.find(({ id }) => id === nodeId);
  if (node === undefined || level === undefined) return [];
  return shownPorts(node, findDefinition(definitions, node), level, 'outputs');
}

/** A step on its level as drawn now, and its card's size. */
function shownStep({
  level,
  nodeId,
  getInternalNode,
}: Readonly<{
  level: GraphLevel;
  nodeId: string;
  getInternalNode: ReturnType<typeof useReactFlow>['getInternalNode'];
}>) {
  const node = level.nodes.find(({ id }) => id === nodeId);
  const measured = getInternalNode(nodeId)?.measured;
  return node === undefined
    ? undefined
    : {
        node,
        width: measured?.width ?? cardSize(node).width,
        height: measured?.height ?? cardSize(node).height,
      };
}

/** A body's one last step, when it has an output a new step can follow. */
function afterLastStep({
  body,
  store,
  definitions,
  getInternalNode,
}: Readonly<{
  body: GraphLevel;
  store: EditorStore;
  definitions: readonly NodeDefinitionCatalogItem[];
  getInternalNode: ReturnType<typeof useReactFlow>['getInternalNode'];
}>) {
  const [last, ...others] = levelSinks(body);
  const step =
    last === undefined || others.length > 0
      ? undefined
      : shownStep({ level: body, nodeId: last, getInternalNode });
  if (step === undefined) return undefined;
  const outputs = outputsOf({ store, definitions, nodeId: step.node.id });
  const port = openOutputPort(body, step.node.id, outputs);
  return port === undefined
    ? undefined
    : {
        from: { nodeId: step.node.id, port },
        outputs,
        position: positionAfter(step.node, step.width),
      };
}
