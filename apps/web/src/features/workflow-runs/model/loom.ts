import type { WorkflowRunReadSummary } from '@pertexo/contracts/schemas/workflow-runs';
import type { StatusTone } from '@/components/ui/status';
import { formatRelativeTime } from '@/lib/format-time';
import { workflowLabel } from './run-list';
import {
  describeRunStatus,
  isActiveRunStatus,
  type RunStatus,
} from './run-status';

// The Loom: time laid sideways, one lane per workflow. Pure data shaping and
// geometry shared by the canvas renderer, its hit testing and the list
// alternative, so all three always agree.

export type LoomRun = Readonly<{
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  tone: StatusTone;
  startMs: number;
  /** Null while the run is still active: its thread grows to "now". */
  endMs: number | null;
  createdAt: string;
}>;

export type LoomLane = Readonly<{
  key: string;
  label: string;
  runs: readonly LoomRun[];
  /** Every run of this workflow in the window, from the statistics read. */
  total?: number;
}>;

export type LoomTick = Readonly<{ offsetMs: number; label: string }>;

export type LoomModel = Readonly<{
  windowMs: number;
  lanes: readonly LoomLane[];
  runCount: number;
  /** Running runs, which feed the Core. */
  liveCount: number;
  hiddenLaneCount: number;
  ticks: readonly LoomTick[];
}>;

const LOOM_MAX_LANES = 8;
const TICK_STEPS_MS = [
  60_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000,
  10_800_000, 14_400_000, 21_600_000, 43_200_000, 86_400_000, 172_800_000,
  604_800_000,
];

function toLoomRun(run: WorkflowRunReadSummary): LoomRun {
  const active = isActiveRunStatus(run.status);
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: workflowLabel(run),
    status: run.status,
    tone: describeRunStatus(run.status).tone,
    startMs: Date.parse(run.startedAt ?? run.createdAt),
    endMs: active ? null : Date.parse(run.completedAt ?? run.updatedAt),
    createdAt: run.createdAt,
  };
}

function latestById(
  runs: readonly WorkflowRunReadSummary[],
): WorkflowRunReadSummary[] {
  const byId = new Map<string, WorkflowRunReadSummary>();
  for (const run of runs) {
    const known = byId.get(run.id);
    if (known === undefined || known.updatedAt < run.updatedAt)
      byId.set(run.id, run);
  }
  return [...byId.values()];
}

function loomTicks(windowMs: number, nowMs: number): readonly LoomTick[] {
  const step =
    TICK_STEPS_MS.find((candidate) => windowMs / candidate <= 6) ??
    TICK_STEPS_MS.at(-1) ??
    windowMs;
  const ticks: LoomTick[] = [];
  for (let offset = 0; offset <= windowMs; offset += step)
    ticks.push({
      offsetMs: offset,
      label:
        offset === 0
          ? 'now'
          : formatRelativeTime(new Date(nowMs - offset).toISOString(), nowMs),
    });
  return ticks;
}

/**
 * Lanes for the runs that touch the window, busiest-recently first. Active
 * runs that started before the window are clipped to its left edge.
 */
export function shapeLoom(
  runs: readonly WorkflowRunReadSummary[],
  window: Readonly<{
    windowMs: number;
    nowMs: number;
    maxLanes?: number;
    laneTotals?: ReadonlyMap<string, number>;
  }>,
): LoomModel {
  const windowStart = window.nowMs - window.windowMs;
  const lanes = new Map<
    string,
    { key: string; label: string; runs: LoomRun[]; lastActivity: number }
  >();
  let runCount = 0;
  let liveCount = 0;
  for (const summary of latestById(runs)) {
    const run = toLoomRun(summary);
    if (run.endMs !== null && run.endMs < windowStart) continue;
    runCount += 1;
    if (run.status === 'running') liveCount += 1;
    const activity = run.endMs ?? window.nowMs;
    const lane = lanes.get(run.workflowId);
    if (lane === undefined)
      lanes.set(run.workflowId, {
        key: run.workflowId,
        label: run.workflowName,
        runs: [run],
        lastActivity: activity,
      });
    else {
      lane.runs.push(run);
      lane.lastActivity = Math.max(lane.lastActivity, activity);
    }
  }
  const ordered = [...lanes.values()].sort(
    (left, right) => right.lastActivity - left.lastActivity,
  );
  const maxLanes = window.maxLanes ?? LOOM_MAX_LANES;
  return {
    windowMs: window.windowMs,
    lanes: ordered.slice(0, maxLanes).map((lane) => {
      const total = window.laneTotals?.get(lane.key);
      return {
        key: lane.key,
        label: lane.label,
        runs: [...lane.runs].sort(
          (left, right) => left.startMs - right.startMs,
        ),
        ...(total === undefined ? {} : { total }),
      };
    }),
    runCount,
    liveCount,
    hiddenLaneCount: Math.max(0, ordered.length - maxLanes),
    ticks: loomTicks(window.windowMs, window.nowMs),
  };
}

export type LoomLayout = Readonly<{
  width: number;
  height: number;
  labelRight: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  laneHeight: number;
  core: Readonly<{ x: number; y: number; radius: number }>;
}>;

/**
 * The loom's geometry. The Core sits in a fixed column on the right (the
 * component overlays `CoreOrb` there): 190 px wide on roomy canvases, 56 px
 * below 640 px so a phone's threads keep the width, with the orb's sphere
 * radius at 36 % of its box.
 */
const LOOM_COMPACT_WIDTH = 640;

/**
 * How tall the loom is for its lanes: a single workflow's thread doesn't sit
 * alone in a tall empty frame, and many lanes stop growing at the cap.
 */
export function loomHeight(laneCount: number): number {
  return Math.min(320, Math.max(176, 64 + laneCount * 52));
}

/** From this height a roomy loom's Core is drawn at full size. */
export const LOOM_TALL_HEIGHT = 260;

export function loomLayout(
  model: Pick<LoomModel, 'lanes'>,
  width: number,
  height: number,
): LoomLayout {
  const compact = width < LOOM_COMPACT_WIDTH;
  const labelRight = compact ? 0 : Math.min(176, width * 0.24);
  const left = compact ? 12 : labelRight + 12;
  const coreSpace = compact ? 56 : 190;
  const right = Math.max(left + 40, width - coreSpace);
  const top = compact ? 28 : 18;
  const bottom = height - 30;
  const laneCount = Math.max(1, model.lanes.length);
  const laneHeight = Math.max(18, (bottom - top) / laneCount);
  return {
    width,
    height,
    labelRight,
    left,
    right,
    top,
    bottom,
    laneHeight,
    core: {
      x: width - coreSpace / 2,
      y: (top + bottom) / 2,
      radius: compact ? 18 : height >= LOOM_TALL_HEIGHT ? 52 : 40,
    },
  };
}

/** Horizontal position of an instant; "now" is the right edge. */
export function loomX(
  layout: LoomLayout,
  windowMs: number,
  nowMs: number,
  timeMs: number,
): number {
  const share = (timeMs - (nowMs - windowMs)) / windowMs;
  return layout.left + share * (layout.right - layout.left);
}

export function loomLaneY(layout: LoomLayout, laneIndex: number): number {
  return layout.top + (laneIndex + 0.5) * layout.laneHeight;
}

/** The run's drawn span, clipped to the window and at least a few pixels. */
export function loomRunSpan(
  layout: LoomLayout,
  model: Pick<LoomModel, 'windowMs'>,
  nowMs: number,
  run: LoomRun,
): Readonly<{ x0: number; x1: number }> {
  const x0 = Math.max(
    layout.left,
    loomX(layout, model.windowMs, nowMs, run.startMs),
  );
  const x1 = Math.min(
    layout.right,
    loomX(layout, model.windowMs, nowMs, run.endMs ?? nowMs),
  );
  return { x0, x1: Math.max(x1, x0 + 3) };
}

/** Every run under a pointer, oldest first; overlapping runs all count. */
export function runsAtPointer(
  model: LoomModel,
  layout: LoomLayout,
  nowMs: number,
  x: number,
  y: number,
): readonly LoomRun[] {
  const laneIndex = Math.floor((y - layout.top) / layout.laneHeight);
  const lane = model.lanes[laneIndex];
  if (lane === undefined) return [];
  const tolerance = 5;
  return lane.runs.filter((run) => {
    const span = loomRunSpan(layout, model, nowMs, run);
    return x >= span.x0 - tolerance && x <= span.x1 + tolerance;
  });
}

/** The run under a pointer, preferring the most recent where they overlap. */
export function hitTestLoom(
  model: LoomModel,
  layout: LoomLayout,
  nowMs: number,
  x: number,
  y: number,
): LoomRun | undefined {
  return runsAtPointer(model, layout, nowMs, x, y).at(-1);
}
