import { statusFinishes } from './replay-builder';
import type { RunTimelineRow, RunTimelineSegment } from './runs';

/** Place the Agent above its activity even when its own events arrive last. */
export function groupAgentRows(
  rows: readonly RunTimelineRow[],
): RunTimelineRow[] {
  const parents = new Map(
    rows
      .filter((row) => row.agentWork === undefined)
      .map((row) => [row.key, row]),
  );
  const activity = new Map<string, RunTimelineRow[]>();
  for (const row of rows) {
    const parentKey = row.agentWork?.parentInvocationKey;
    if (parentKey === undefined || !parents.has(parentKey)) continue;
    const children = activity.get(parentKey);
    if (children === undefined) activity.set(parentKey, [row]);
    else children.push(row);
  }

  const grouped: RunTimelineRow[] = [];
  const placed = new Set<string>();
  for (const row of rows) {
    const parentKey = row.agentWork?.parentInvocationKey ?? row.key;
    const children = activity.get(parentKey);
    const parent = parents.get(parentKey);
    if (children === undefined || parent === undefined) {
      grouped.push(row);
    } else if (!placed.has(parentKey)) {
      placed.add(parentKey);
      grouped.push(withAgentSpan(parent, children), ...children);
    }
  }
  return grouped;
}

function withAgentSpan(
  parent: RunTimelineRow,
  children: readonly RunTimelineRow[],
): RunTimelineRow {
  let startMs = Number.POSITIVE_INFINITY;
  for (const child of children) {
    if (child.agentWork?.work.kind !== 'model_turn') continue;
    const attempt = child.segments.find(({ kind }) => kind === 'attempt');
    const start =
      attempt?.startMs ??
      (child.startedAt === undefined ? undefined : Date.parse(child.startedAt));
    if (start !== undefined) startMs = Math.min(startMs, start);
  }
  if (!Number.isFinite(startMs) || parent.reused !== undefined) return parent;

  const finish =
    parent.status === 'not_started' ? undefined : statusFinishes[parent.status];
  const completedAt =
    parent.completedAt ??
    (finish === undefined ? undefined : parent.story.at(-1)?.endedAt);
  const agentSpan: RunTimelineSegment = {
    kind: 'attempt',
    tone: finish?.tone ?? 'live',
    startMs,
    endMs: completedAt === undefined ? null : Date.parse(completedAt),
    ...(finish === undefined ? {} : { end: finish.end }),
  };
  const story = parent.story.map((entry, index) =>
    index === parent.story.length - 1 &&
    entry.kind === 'attempt' &&
    entry.endedAt !== undefined &&
    entry.startedAt === entry.endedAt
      ? { ...entry, startedAt: new Date(startMs).toISOString() }
      : entry,
  );
  return { ...parent, agentSpan, segments: [agentSpan], story };
}
