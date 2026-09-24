import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { useEffect, useState } from 'react';
import { edgeWeaveOrder, upstreamEdgeIds } from './graph-order';

/** How long a passed test's path keeps flowing along the canvas. */
export const TEST_FLOW_MS = 10_000;
/** The weave-in plus the stamp; the canvas returns to rest afterwards. */
export const WEAVE_MS = 4_600;

const noEdges: ReadonlySet<string> = new Set();

/**
 * Short-lived canvas moments that mean something: the path of a passed test
 * flows for a few seconds, and a publish weaves its connections in execution
 * order. Timers are the external system; reduced motion is handled in CSS.
 */
export function useCanvasEffects(graph: WorkflowGraphContract) {
  const [flow, setFlow] =
    useState<Readonly<{ edgeIds: ReadonlySet<string>; startedAt: number }>>();
  const [weave, setWeave] =
    useState<
      Readonly<{ order: ReadonlyMap<string, number>; startedAt: number }>
    >();

  useEffect(() => {
    if (flow === undefined) return;
    const timer = window.setTimeout(() => {
      setFlow(undefined);
    }, TEST_FLOW_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [flow]);

  useEffect(() => {
    if (weave === undefined) return;
    const timer = window.setTimeout(() => {
      setWeave(undefined);
    }, WEAVE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [weave]);

  return {
    flowingEdgeIds: flow?.edgeIds ?? noEdges,
    weaveOrder: weave?.order ?? null,
    showTestPath: (nodeId: string) => {
      setFlow({
        edgeIds: upstreamEdgeIds(graph, nodeId),
        startedAt: Date.now(),
      });
    },
    weaveIn: () => {
      setWeave({ order: edgeWeaveOrder(graph), startedAt: Date.now() });
    },
  } as const;
}
