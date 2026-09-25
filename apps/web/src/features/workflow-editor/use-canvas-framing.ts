import { useNodesInitialized, useReactFlow } from '@xyflow/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import {
  CANVAS_COVER_ATTRIBUTE,
  framedViewport,
  inset,
  READABLE_ZOOM,
  revealedViewport,
  uncoveredArea,
  type Box,
} from './model/canvas-framing';
import { useEditorStore } from './model/editor-store-context';
import type { WorkflowFlowEdge, WorkflowFlowNode } from './model/graph-adapter';

const FIT_PADDING = 24;
const REVEAL_MARGIN = 24;

/**
 * Frames the workflow between the editor's lenses: it opens fitted into
 * the area no lens covers (at a readable zoom, starting from the left when
 * it's too wide), Fit does the same, and a newly selected step that the
 * inspector or another lens would hide is panned into view.
 */
export function useCanvasFraming(containerRef: RefObject<HTMLElement | null>) {
  const flow = useReactFlow<WorkflowFlowNode, WorkflowFlowEdge>();
  const reducedMotion = usePrefersReducedMotion();
  const nodesInitialized = useNodesInitialized();
  const selectedNodeId = useEditorStore((state) => state.selectedNodeId);
  const framed = useRef(false);

  const visibleArea = useCallback((): Box | undefined => {
    const container = containerRef.current;
    if (container === null) return undefined;
    const canvas = container.getBoundingClientRect();
    if (canvas.width === 0 || canvas.height === 0) return undefined;
    const covers = [
      ...document.querySelectorAll(`[${CANVAS_COVER_ATTRIBUTE}]`),
    ].map((element) => element.getBoundingClientRect());
    return uncoveredArea(canvas, covers);
  }, [containerRef]);

  const fit = useCallback(
    (animate: boolean) => {
      const area = visibleArea();
      const nodes = flow
        .getNodes()
        .filter((node) => node.parentId === undefined);
      if (area === undefined || nodes.length === 0) return;
      void flow.setViewport(
        framedViewport(flow.getNodesBounds(nodes), inset(area, FIT_PADDING), {
          minZoom: READABLE_ZOOM,
          maxZoom: 1,
        }),
        { duration: animate && !reducedMotion ? 200 : 0 },
      );
    },
    [flow, reducedMotion, visibleArea],
  );

  // Once, as soon as the steps have sizes; before paint, so the first
  // frame is already framed.
  useLayoutEffect(() => {
    if (!nodesInitialized || framed.current) return;
    framed.current = true;
    fit(false);
  }, [fit, nodesInitialized]);

  // A step added and selected in one move has no size on its first render,
  // so this runs again once it's measured.
  useEffect(() => {
    if (selectedNodeId === null || !nodesInitialized) return;
    const node = flow.getInternalNode(selectedNodeId);
    const area = visibleArea();
    const width = node?.measured.width;
    const height = node?.measured.height;
    if (
      node === undefined ||
      area === undefined ||
      width === undefined ||
      height === undefined
    )
      return;
    const next = revealedViewport(
      { ...node.internals.positionAbsolute, width, height },
      inset(area, REVEAL_MARGIN),
      flow.getViewport(),
    );
    if (next !== undefined)
      void flow.setViewport(next, { duration: reducedMotion ? 0 : 250 });
  }, [flow, nodesInitialized, reducedMotion, selectedNodeId, visibleArea]);

  return fit;
}
