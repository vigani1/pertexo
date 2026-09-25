import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { useEffect, useState } from 'react';
import { edgeWeaveOrder, upstreamEdgeIds } from './model/graph-order';
import { levelOf } from './model/graph-scopes';

/** How long a passed test's path keeps flowing along the canvas. */
const TEST_FLOW_MS = 10_000;
/** The weave-in plus the stamp; the canvas returns to rest afterwards. */
const WEAVE_MS = 4_600;

const noEdges: ReadonlySet<string> = new Set();

/**
 * Short-lived canvas moments that mean something: the path of a passed test
 * flows for a few seconds, and a publish weaves its connections in execution
 * order. Timers are the external system; reduced motion is handled in CSS.
 * Each step's card also keeps the output size of its last passed test in
 * this session, when the output came back inline.
 */
export function useCanvasEffects(graph: WorkflowGraphContract) {
  const [testOutputBytes, setTestOutputBytes] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
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
    testOutputBytes,
    showTestPath: (nodeId: string, outputBytes: number | undefined) => {
      setTestOutputBytes((current) => {
        const next = new Map(current);
        if (outputBytes === undefined) next.delete(nodeId);
        else next.set(nodeId, outputBytes);
        return next;
      });
      setFlow({
        edgeIds: upstreamEdgeIds(levelOf(graph, nodeId) ?? graph, nodeId),
        startedAt: Date.now(),
      });
    },
    weaveIn: () => {
      setWeave({ order: edgeWeaveOrder(graph), startedAt: Date.now() });
    },
  } as const;
}
