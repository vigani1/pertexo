import { useNodes, ViewportPortal } from '@xyflow/react';
import { useMemo } from 'react';
import { isClassifyDefinition } from '@pertexo/workflow-model';
import { portName } from '@/features/catalog/public';
import { useEditorStore } from '../../model/state/context';
import { workflowLanes } from '../../model/graph/lanes';
import { classifyPortLabels } from '../../model/classify-categories';
import type { WorkflowNode } from '../../model/graph/scopes';

// Room around the steps of a lane, and below them for the last run's line.
const BAND_PADDING = Object.freeze({ x: 72, top: 22, bottom: 40 });
// Steps further apart than this aren't in a row, so no band is drawn.
const ROW_TOLERANCE = 48;

type Box = Readonly<{ x: number; y: number; width: number; height: number }>;

/**
 * Lanes behind the workflow once its branches sit in rows (after Tidy
 * lanes, or drawn that way): a soft band for each branch, named by the step
 * and port it leaves from, and the name of the lane the workflow starts in.
 * A drawing that isn't in rows gets no bands rather than crooked ones.
 */
export function LaneBands() {
  const graph = useEditorStore((state) => state.graph);
  const flowNodes = useNodes();
  const bands = useMemo(() => {
    const boxes = new Map<string, Box>();
    for (const node of flowNodes)
      if (node.parentId === undefined)
        boxes.set(node.id, {
          ...node.position,
          width: node.measured?.width ?? 0,
          height: node.measured?.height ?? 0,
        });
    return laneBands(graph.nodes, boxes, workflowLanes(graph));
  }, [flowNodes, graph]);
  if (bands === null) return null;
  return (
    <ViewportPortal>
      {bands.map((band) => (
        <div
          key={band.key}
          aria-hidden="true"
          className={
            band.branch
              ? 'pointer-events-none absolute -z-10 lane-band'
              : 'pointer-events-none absolute -z-10'
          }
          style={{
            transform: `translate(${String(band.x)}px, ${String(band.y)}px)`,
            width: band.width,
            height: band.height,
          }}
        >
          <span className="absolute top-1.5 left-5 font-mono text-micro tracking-wide text-subtle-foreground">
            {band.label}
          </span>
        </div>
      ))}
    </ViewportPortal>
  );
}

function laneBands(
  nodes: readonly WorkflowNode[],
  boxes: ReadonlyMap<string, Box>,
  lanes: ReturnType<typeof workflowLanes>,
) {
  if (lanes.length < 2 || boxes.size === 0) return null;
  const all = [...boxes.values()];
  const left = Math.min(...all.map((box) => box.x)) - BAND_PADDING.x;
  const right =
    Math.max(...all.map((box) => box.x + box.width)) + BAND_PADDING.x;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const bands = [];
  for (const lane of lanes) {
    const laneBoxes = lane.nodeIds.flatMap((id) => {
      const box = boxes.get(id);
      return box === undefined ? [] : [box];
    });
    if (laneBoxes.length === 0) continue;
    const top = Math.min(...laneBoxes.map((box) => box.y));
    if (laneBoxes.some((box) => box.y - top > ROW_TOLERANCE)) return null;
    const bottom = Math.max(...laneBoxes.map((box) => box.y + box.height));
    const opener =
      lane.opener === null ? undefined : byId.get(lane.opener.nodeId);
    bands.push({
      key: lane.nodeIds[0] ?? String(lane.rank),
      branch: lane.opener !== null,
      label:
        lane.opener === null || opener === undefined
          ? 'main'
          : `${opener.label ?? opener.definition.key} · ${branchName(opener, lane.opener.port)}`,
      x: left,
      y: top - BAND_PADDING.top,
      width: right - left,
      height: bottom - top + BAND_PADDING.top + BAND_PADDING.bottom,
    });
  }
  return bands;
}

function branchName(node: WorkflowNode, port: string): string {
  if (isClassifyDefinition(node.definition)) {
    const label = classifyPortLabels(node.config)[port];
    if (label !== undefined) return label;
  }
  return portName(port).toLowerCase();
}
