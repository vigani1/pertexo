import type { WorkflowRunSummary } from '@pertexo/contracts';
import { formatDurationMs } from '@/lib/format/time';
import { isActiveRunStatus } from '../presentation/run-status';
import type { RunTimelineSegment } from './step-replay';
import type { RunTimelineModel } from './runs';

export type RunTimelineTick = Readonly<{ offsetMs: number; label: string }>;

const TICK_STEPS_MS = [
  100, 250, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000,
  300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000,
  43_200_000, 86_400_000,
];

export function runBounds(run: WorkflowRunSummary, nowMs: number) {
  const startMs = Date.parse(run.startedAt ?? run.createdAt);
  const endMs = isActiveRunStatus(run.status)
    ? null
    : Date.parse(run.completedAt ?? run.updatedAt);
  return { startMs, endMs, axisEndMs: endMs ?? Math.max(nowMs, startMs) };
}

export function timelineTicks(durationMs: number): readonly RunTimelineTick[] {
  const step =
    TICK_STEPS_MS.find((candidate) => durationMs / candidate <= 6) ??
    durationMs;
  const ticks: RunTimelineTick[] = [];
  for (let offset = 0; offset <= durationMs; offset += step)
    ticks.push({
      offsetMs: offset,
      label: offset === 0 ? '0' : formatDurationMs(offset),
    });
  return ticks;
}

/** A segment's start and width as percentages of the axis. */
export function segmentPlacement(
  view: Pick<RunTimelineModel, 'startMs' | 'endMs'>,
  segment: RunTimelineSegment,
  nowMs: number,
): Readonly<{ left: number; width: number }> {
  const span = view.endMs - view.startMs;
  const start = Math.min(Math.max(segment.startMs, view.startMs), view.endMs);
  const end = Math.min(
    Math.max(segment.endMs ?? Math.min(nowMs, view.endMs), start),
    view.endMs,
  );
  return {
    left: ((start - view.startMs) / span) * 100,
    width: ((end - start) / span) * 100,
  };
}
