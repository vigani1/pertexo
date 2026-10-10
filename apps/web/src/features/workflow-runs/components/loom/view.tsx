import type { WorkflowRunReadSummary } from '@pertexo/contracts';
import { useEffect, useMemo, useRef } from 'react';
import { CoreOrb } from '@/components/patterns/core/orb';
import { useCanvasRenderer } from '@/lib/hooks/use-canvas-renderer';
import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion';
import {
  LOOM_TALL_HEIGHT,
  loomHeight,
  shapeLoom,
  type LoomModel,
} from '../../model/loom/model';
import { useNow } from '@/lib/hooks/use-now';
import { LoomRunList } from './run-list';
import { LoomThreadLinks } from './thread-links';
import { LoomRenderer } from '../../model/loom/renderer';

function coreEnergy(liveCount: number): number {
  return 0.6 + Math.min(liveCount, 6) * 0.15;
}

/**
 * The Loom: one lane per workflow, runs drawn from start to end, running
 * threads growing into the Core at "now". Native links over each thread
 * provide pointer and keyboard navigation; the list offers a text view.
 */
export function RunLoom({
  runs,
  windowMs,
  windowLabel,
  workspaceId,
  laneTotals,
}: Readonly<{
  runs: readonly WorkflowRunReadSummary[];
  windowMs: number;
  /** "the last hour", used in the accessible summary and empty state. */
  windowLabel: string;
  workspaceId: string;
  /** Exact runs per workflow in the window, when the statistics read has them. */
  laneTotals?: ReadonlyMap<string, number> | undefined;
}>) {
  const nowMs = useNow(15_000, true);
  const model = useMemo(
    () =>
      shapeLoom(runs, {
        windowMs,
        nowMs,
        ...(laneTotals === undefined ? {} : { laneTotals }),
      }),
    [runs, windowMs, nowMs, laneTotals],
  );

  const summary = `Timeline of ${String(model.runCount)} ${
    model.runCount === 1 ? 'run' : 'runs'
  } across ${String(model.lanes.length)} ${
    model.lanes.length === 1 ? 'workflow' : 'workflows'
  } over ${windowLabel}.`;

  const height = loomHeight(model.lanes.length);
  return (
    <div className="flex flex-col gap-3">
      <div
        className="@container relative overflow-hidden rounded-xl border border-white/6 bg-linear-to-b from-white/[0.018] to-transparent transition-[height] duration-300 ease-out motion-reduce:transition-none"
        style={{ height }}
      >
        <LoomCanvas model={model} label={summary} />
        <LoomThreadLinks
          model={model}
          workspaceId={workspaceId}
          height={height}
          nowMs={nowMs}
        />
        <div className="pointer-events-none absolute top-[28px] right-0 bottom-[30px] flex w-[56px] flex-col items-center justify-center gap-1 @min-[640px]:top-[18px] @min-[640px]:w-[190px]">
          <CoreOrb
            state={model.liveCount > 0 ? 'live' : 'idle'}
            energy={coreEnergy(model.liveCount)}
            className={
              height >= LOOM_TALL_HEIGHT
                ? 'size-12 @min-[640px]:size-36'
                : 'size-12 @min-[640px]:size-28'
            }
          />
          <p className="font-mono text-[0.7rem] font-semibold text-accent-foreground/90 @max-[639px]:hidden">
            {String(model.liveCount)} running
          </p>
        </div>
        {model.runCount === 0 ? (
          <p className="absolute inset-x-6 top-1/2 -translate-y-1/2 text-center text-sm text-subtle-foreground @min-[640px]:right-[190px]">
            No runs in {windowLabel}.
          </p>
        ) : null}
      </div>
      <LoomRunList
        model={model}
        workspaceId={workspaceId}
        windowLabel={windowLabel}
      />
    </div>
  );
}

function LoomCanvas({
  model,
  label,
}: Readonly<{ model: LoomModel; label: string }>) {
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
      className="absolute inset-0 size-full"
    />
  );
}
