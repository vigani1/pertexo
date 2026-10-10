import { Link } from '@tanstack/react-router';
import { useLayoutEffect, useRef, useState } from 'react';
import { Status } from '@/components/ui/status';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatDateTime, formatDurationMs } from '@/lib/format/time';
import {
  loomLaneY,
  loomLayout,
  loomRunSpan,
  type LoomLayout,
  type LoomModel,
  type LoomRun,
} from '../../model/loom/model';
import { describeRunStatus } from '../../model/run-status';

/** Native links share the renderer's geometry, including overlapping runs. */
export function LoomThreadLinks({
  model,
  workspaceId,
  height,
  nowMs,
}: Readonly<{
  model: LoomModel;
  workspaceId: string;
  height: number;
  nowMs: number;
}>) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const resize = () => {
      setWidth(svg.getBoundingClientRect().width);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(svg);
    return () => {
      observer.disconnect();
    };
  }, []);
  const layout = loomLayout(model, width, height);

  return (
    <svg
      ref={svgRef}
      role="group"
      aria-label="Runs on this timeline"
      className="absolute inset-0 size-full"
    >
      {width === 0
        ? null
        : model.lanes.flatMap((lane, laneIndex) => {
            const y = loomLaneY(layout, laneIndex);
            return lane.runs.map((run) => {
              const span = loomRunSpan(layout, model, nowMs, run);
              return (
                <Tooltip key={run.id}>
                  <TooltipTrigger
                    render={
                      <Link
                        to="/w/$workspaceId/runs/$runId"
                        params={{ workspaceId, runId: run.id }}
                        aria-label={`${run.workflowName}: ${describeRunStatus(run.status).label}, ${formatDateTime(run.createdAt)}`}
                        className="group outline-none"
                      />
                    }
                  >
                    <rect
                      x={span.x0 - 5}
                      y={y - 12}
                      width={Math.max(24, span.x1 - span.x0 + 10)}
                      height={24}
                      rx={4}
                      className="fill-transparent stroke-transparent stroke-2 group-focus-visible:fill-primary/15 group-focus-visible:stroke-primary"
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    <LoomRunPreview
                      run={run}
                      neighbors={lane.runs}
                      model={model}
                      layout={layout}
                      nowMs={nowMs}
                    />
                  </TooltipContent>
                </Tooltip>
              );
            });
          })}
    </svg>
  );
}

function LoomRunPreview({
  run,
  neighbors,
  model,
  layout,
  nowMs,
}: Readonly<{
  run: LoomRun;
  neighbors: readonly LoomRun[];
  model: LoomModel;
  layout: LoomLayout;
  nowMs: number;
}>) {
  const look = describeRunStatus(run.status);
  const durationMs = (run.endMs ?? nowMs) - run.startMs;
  const span = loomRunSpan(layout, model, nowMs, run);
  const alsoHere = neighbors.filter((other) => {
    if (other.id === run.id) return false;
    const otherSpan = loomRunSpan(layout, model, nowMs, other);
    return otherSpan.x0 <= span.x1 && otherSpan.x1 >= span.x0;
  }).length;
  return (
    <div className="flex w-56 flex-col gap-1">
      <p className="truncate font-semibold">{run.workflowName}</p>
      <div className="flex items-center justify-between gap-3">
        <Status tone={look.tone}>{look.label}</Status>
        <span className="font-mono">{formatDurationMs(durationMs)}</span>
      </div>
      <p className="font-mono">{formatDateTime(run.createdAt)}</p>
      {alsoHere === 0 ? null : (
        <p>
          {alsoHere === 1
            ? '1 more run here: list them below the Loom.'
            : `${String(alsoHere)} more runs here: list them below the Loom.`}
        </p>
      )}
    </div>
  );
}
