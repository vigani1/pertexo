import type { Connection, Edge, FinalConnectionState } from '@xyflow/react';
import { useCallback } from 'react';
import { linkWorkflowNodes, type PortRef } from '../../model/graph/commands';
import type { useEditorStoreApi } from '../../model/state/context';
import { canLinkSteps } from '../../model/graph/scopes';
import { gestureEndPoint, portDropSource } from '../../model/quick-add';
import type { Position } from './projection';

/**
 * Links drawn on the canvas: only between steps on the same level (a
 * body's steps link only to each other), added as one change, and a
 * link dropped on empty canvas opens quick add there.
 */
export function useLinkGestures({
  store,
  editable,
  onPortDrop,
}: Readonly<{
  store: ReturnType<typeof useEditorStoreApi>;
  editable: boolean;
  onPortDrop: (from: PortRef, point: Position) => void;
}>) {
  const isValidConnection = useCallback(
    (link: Connection | Edge) => {
      const graph = store.getState().graph;
      return (
        canLinkSteps(graph, link.source, link.target) &&
        linkWorkflowNodes(graph, {
          source: link.source,
          target: link.target,
          sourceHandle: link.sourceHandle ?? null,
          targetHandle: link.targetHandle ?? null,
        }) !== null
      );
    },
    [store],
  );
  const onConnect = useCallback(
    (link: Connection) => {
      if (!editable) return;
      const state = store.getState();
      const next = linkWorkflowNodes(state.graph, link);
      if (next !== null) state.transact(next);
    },
    [editable, store],
  );
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      const point = gestureEndPoint(event);
      if (!editable || point === null) return;
      const from = portDropSource({ state, endedOverStep: isOverStep(point) });
      if (from !== null) onPortDrop(from, point);
    },
    [editable, onPortDrop],
  );
  return { isValidConnection, onConnect, onConnectEnd } as const;
}

/**
 * Whether a point in the viewport is over a step card rather than canvas.
 * The empty part of a For each body counts as canvas: body steps are drawn
 * above it, so a point over one of them finds that step first.
 */
function isOverStep(point: Position): boolean {
  if (typeof document.elementFromPoint !== 'function') return false;
  const element = document.elementFromPoint(point.x, point.y);
  if (element === null) return false;
  return (
    element.closest('.react-flow__node') !== null &&
    element.closest('[data-for-each-body]') === null
  );
}
