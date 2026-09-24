import type { WorkflowRunReadSummary } from '@pertexo/contracts/schemas/workflow-runs';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { CoreOrb } from '@/components/patterns/core-orb';
import { Status } from '@/components/ui/status';
import { formatDateTime, formatDurationMs } from '@/lib/format-time';
import { useCanvasRenderer } from '@/lib/use-canvas-renderer';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import {
  hitTestLoom,
  loomLayout,
  shapeLoom,
  type LoomModel,
  type LoomRun,
} from '../../model/loom';
import { describeRunStatus } from '../../model/run-status';
import { useNow } from '@/lib/use-now';
import { LoomRunList } from './loom-run-list';
import { LoomRenderer } from './loom-renderer';

type Hover = Readonly<{ run: LoomRun; x: number; y: number }>;

function coreEnergy(liveCount: number): number {
  return 0.6 + Math.min(liveCount, 6) * 0.15;
}

/**
 * The Loom: one lane per workflow, runs drawn from start to end, running
 * threads growing into the Core at "now". Pointer users hover and click a
 * thread; everyone can open the list of plotted runs below it.
 */
export function RunLoom({
  runs,
  windowMs,
  windowLabel,
  workspaceId,
}: Readonly<{
  runs: readonly WorkflowRunReadSummary[];
  windowMs: number;
  /** "the last hour", used in the accessible summary and empty state. */
  windowLabel: string;
  workspaceId: string;
}>) {
  const nowMs = useNow(15_000, true);
  const model = useMemo(
    () => shapeLoom(runs, { windowMs, nowMs }),
    [runs, windowMs, nowMs],
  );
  const navigate = useNavigate();
  const [hover, setHover] = useState<Hover>();

  function locate(event: MouseEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const layout = loomLayout(model, bounds.width, bounds.height);
    const run = hitTestLoom(model, layout, Date.now(), x, y);
    return run === undefined ? undefined : { run, x, y };
  }

  const summary = `Timeline of ${String(model.runCount)} ${
    model.runCount === 1 ? 'run' : 'runs'
  } across ${String(model.lanes.length)} ${
    model.lanes.length === 1 ? 'workflow' : 'workflows'
  } over ${windowLabel}.`;

  return (
    <div className="flex flex-col gap-3">
      <div className="@container relative h-72 overflow-hidden rounded-xl border border-white/6 bg-linear-to-b from-white/[0.018] to-transparent sm:h-80">
        <LoomCanvas
          model={model}
          label={summary}
          interactive={hover !== undefined}
          onPointerMove={(event) => {
            setHover(locate(event));
          }}
          onPointerLeave={() => {
            setHover(undefined);
          }}
          onClick={(event) => {
            const hit = locate(event);
            if (hit === undefined) return;
            void navigate({
              to: '/w/$workspaceId/runs/$runId',
              params: { workspaceId, runId: hit.run.id },
            });
          }}
        />
        <div className="pointer-events-none absolute top-[28px] right-0 bottom-[30px] grid w-[72px] place-items-center @min-[640px]:top-[18px] @min-[640px]:w-[190px]">
          <CoreOrb
            state={model.liveCount > 0 ? 'live' : 'idle'}
            energy={coreEnergy(model.liveCount)}
            className="size-16 @min-[640px]:size-36"
          />
          <p className="absolute bottom-3 font-mono text-[0.7rem] font-semibold text-accent-foreground/90 @max-[639px]:hidden">
            {String(model.liveCount)} live
          </p>
        </div>
        {model.runCount === 0 ? (
          <p className="absolute inset-x-6 top-1/2 -translate-y-1/2 text-center text-sm text-subtle-foreground @min-[640px]:right-[190px]">
            No runs in {windowLabel}.
          </p>
        ) : null}
        {hover === undefined ? null : <LoomLens hover={hover} nowMs={nowMs} />}
      </div>
      <LoomRunList model={model} workspaceId={workspaceId} />
    </div>
  );
}

function LoomCanvas({
  model,
  label,
  interactive,
  onPointerMove,
  onPointerLeave,
  onClick,
}: Readonly<{
  model: LoomModel;
  label: string;
  interactive: boolean;
  onPointerMove: (event: MouseEvent<HTMLCanvasElement>) => void;
  onPointerLeave: () => void;
  onClick: (event: MouseEvent<HTMLCanvasElement>) => void;
}>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const rendererRef = useCanvasRenderer(
    canvasRef,
    (canvas) => new LoomRenderer(canvas, model),
  );

  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer === null) return;
    renderer.setModel(model);
    if (reducedMotion) renderer.render(3);
  }, [rendererRef, model, reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={label}
      data-slot="run-loom"
      className={
        interactive
          ? 'absolute inset-0 size-full cursor-pointer'
          : 'absolute inset-0 size-full'
      }
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onClick={onClick}
    />
  );
}

function LoomLens({ hover, nowMs }: Readonly<{ hover: Hover; nowMs: number }>) {
  const { run } = hover;
  const look = describeRunStatus(run.status);
  const durationMs = (run.endMs ?? nowMs) - run.startMs;
  return (
    <div
      aria-hidden="true"
      className="lens pointer-events-none absolute z-10 w-60 rounded-lg px-3 py-2.5 text-xs"
      style={{
        left: Math.max(8, hover.x - 120),
        top: Math.max(8, hover.y - 96),
      }}
    >
      <p className="truncate text-sm font-semibold">{run.workflowName}</p>
      <div className="mt-1.5 flex items-center justify-between gap-3">
        <Status tone={look.tone}>{look.label}</Status>
        <span className="font-mono text-subtle-foreground">
          {formatDurationMs(durationMs)}
        </span>
      </div>
      <p className="mt-1 font-mono text-subtle-foreground">
        {formatDateTime(run.createdAt)}
      </p>
    </div>
  );
}
