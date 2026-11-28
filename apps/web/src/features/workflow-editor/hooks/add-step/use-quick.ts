import { WORKFLOW_FAILURE_PORT } from '@pertexo/workflow-model';
import { canOwnFailureLink } from '../../model/failure-routing/eligibility';
import { failureLink } from '../../model/failure-routing/failure-routing-commands';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import { useReactFlow } from '@xyflow/react';
import { useState } from 'react';
import {
  shownLevel,
  cardSize,
  STEP_CARD,
  toBodyPosition,
} from '../../model/graph/for-each-body-layout';
import type { EditorStore } from '../../model/state/workflow-editor.store';
import { findDefinition } from '../../model/graph/adapter';
import {
  positionAfter,
  type PortRef,
} from '../../model/graph/workflow-graph-commands';
import { levelSinks } from '../../model/graph/order';
import {
  findStep,
  indexGraph,
  isForEach,
  loopOf,
  scopeOf,
  type GraphLevel,
  type WorkflowEdge,
} from '../../model/graph/scopes';
import { openOutputPort } from '../../model/quick-add';
import { shownPorts } from '../../model/step-card';

type Point = Readonly<{ x: number; y: number }>;

type Placement = Readonly<{
  kind: 'place';
  from: PortRef | undefined;
  loopId: string | undefined;
  position: Point;
}>;

type LinkInsertion = Readonly<{
  kind: 'insert';
  edgeId: string;
  from: PortRef;
}>;

export type QuickAddTarget = Placement | LinkInsertion;

export type QuickAddRequest = (
  (Placement & Readonly<{ outputs: readonly string[] }>) | LinkInsertion
) &
  Readonly<{
    /** Where the lens opens, in viewport coordinates. */
    anchor: Point;
    /** What opened it, to return focus to if it's still there. */
    returnFocus: HTMLElement | null;
  }>;

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
      kind: 'place',
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
      kind: 'place',
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
      kind: 'place',
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
      kind: 'place',
      from: after?.from,
      outputs: after?.outputs ?? [],
      loopId,
      position: after?.position ?? { x: 0, y: 0 },
      anchor: { x: rect.right, y: rect.top + rect.height / 2 },
      returnFocus,
    });
  }

  function openInLink(edgeId: string, returnFocus: HTMLElement) {
    const edge = indexGraph(store.getState().graph).edges.get(edgeId)?.item;
    if (edge !== undefined) setRequest(linkInsertionRequest(edge, returnFocus));
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
    openInLink,
    choosePort: (port: string) => {
      setRequest((current) =>
        current?.kind === 'place' && current.from !== undefined
          ? { ...current, from: { ...current.from, port } }
          : current,
      );
    },
    choose,
    close: () => {
      setRequest(undefined);
    },
  } as const;
}

function linkInsertionRequest(
  edge: WorkflowEdge,
  returnFocus: HTMLElement,
): QuickAddRequest {
  const rect = returnFocus.getBoundingClientRect();
  return {
    kind: 'insert',
    edgeId: edge.id,
    from: edge.source,
    anchor: { x: rect.right, y: rect.top + rect.height / 2 },
    returnFocus,
  };
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
