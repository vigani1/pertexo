import type { StatusTone } from '@/components/ui/status';
import {
  CanvasScene,
  readTokenColors,
  rgba,
  type Rgb,
} from '@/lib/canvas-scene';
import {
  loomLaneY,
  loomLayout,
  loomRunSpan,
  loomX,
  type LoomLayout,
  type LoomModel,
  type LoomRun,
} from '../../model/loom';

// Canvas 2D drawing for the Loom. Threads are drawn from real run times;
// running ones grow to "now" and feed light into the Core overlaid on the
// right. Pure drawing: the React component owns lifecycle and interaction.

const FALLBACK: Rgb = [127, 139, 142];
const TOKENS = {
  live: ['--primary', FALLBACK],
  tip: ['--accent-foreground', FALLBACK],
  success: ['--success', FALLBACK],
  failure: ['--destructive', FALLBACK],
  pending: ['--secondary', FALLBACK],
  warning: ['--warning', FALLBACK],
  muted: ['--subtle-foreground', FALLBACK],
  label: ['--muted-foreground', FALLBACK],
} as const;

type Palette = Record<keyof typeof TOKENS, Rgb>;

const KNOT_PULSE_MS = 900;
const MONO_FONT = '500 10px "JetBrains Mono Variable", ui-monospace, monospace';
const LABEL_FONT = '500 12px "Inter Variable", system-ui, sans-serif';

function toneColor(palette: Palette, tone: StatusTone): Rgb {
  switch (tone) {
    case 'live':
      return palette.live;
    case 'success':
      return palette.success;
    case 'failure':
    case 'timeout':
      return palette.failure;
    case 'queued':
    case 'waiting':
      return palette.pending;
    case 'attention':
      return palette.warning;
    default:
      return palette.muted;
  }
}

function bezierPoint(
  points: readonly number[],
  t: number,
): readonly [number, number] {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] =
    points;
  const u = 1 - t;
  return [
    u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
    u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
  ];
}

export class LoomRenderer extends CanvasScene {
  readonly #palette: Palette;
  readonly #landed = new Map<string, number>();
  #model: LoomModel;

  public constructor(canvas: HTMLCanvasElement, model: LoomModel) {
    super(canvas);
    this.#palette = readTokenColors(TOKENS);
    this.#model = model;
  }

  /** Swaps in fresh data; runs that just finished tie a knot once. */
  public setModel(model: LoomModel): void {
    const previouslyActive = new Set<string>();
    for (const lane of this.#model.lanes)
      for (const run of lane.runs)
        if (run.endMs === null) previouslyActive.add(run.id);
    const now = performance.now();
    for (const lane of model.lanes)
      for (const run of lane.runs)
        if (run.endMs !== null && previouslyActive.has(run.id))
          this.#landed.set(run.id, now);
    this.#model = model;
  }

  public render(timeSeconds: number): void {
    const context = this.beginFrame();
    const { width, height } = this;
    if (width === 0 || height === 0) return;
    const nowMs = Date.now();
    const layout = loomLayout(this.#model, width, height);
    this.#drawGrid(layout, nowMs);
    const tips: (readonly [number, number])[] = [];
    context.lineCap = 'round';
    this.#model.lanes.forEach((lane, index) => {
      const y = loomLaneY(layout, index);
      for (const run of lane.runs) {
        const span = loomRunSpan(layout, this.#model, nowMs, run);
        if (span.x1 < layout.left) continue;
        if (run.tone === 'live') {
          this.#drawLive(span.x0, span.x1, y);
          tips.push([span.x1, y]);
        } else this.#drawRun(run, span.x0, span.x1, y, timeSeconds);
      }
    });
    this.#drawTips(layout, tips, timeSeconds);
  }

  #drawGrid(layout: LoomLayout, nowMs: number): void {
    const context = this.context;
    const palette = this.#palette;
    context.font = MONO_FONT;
    context.textAlign = 'center';
    const { ticks, windowMs } = this.#model;
    const stepMs = (ticks[1]?.offsetMs ?? windowMs) - (ticks[0]?.offsetMs ?? 0);
    const spacing = ((layout.right - layout.left) * stepMs) / windowMs;
    // Label only as many ticks as fit; narrow looms keep every gridline.
    const labelEvery = Math.max(1, Math.ceil(76 / Math.max(spacing, 1)));
    for (const [index, tick] of ticks.entries()) {
      const x = loomX(
        layout,
        this.#model.windowMs,
        nowMs,
        nowMs - tick.offsetMs,
      );
      context.strokeStyle = 'rgba(255,255,255,0.045)';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x, layout.top - 6);
      context.lineTo(x, layout.bottom);
      context.stroke();
      if (index % labelEvery !== 0) continue;
      context.fillStyle = rgba(palette.muted, 0.85);
      const half = context.measureText(tick.label).width / 2;
      context.fillText(
        tick.label,
        Math.min(Math.max(x, half + 2), layout.width - half - 2),
        layout.bottom + 18,
      );
    }
    this.#model.lanes.forEach((lane, index) => {
      const y = loomLaneY(layout, index);
      // The lane's exact window total sits at the end of its label column.
      const total = lane.total === undefined ? '' : String(lane.total);
      context.font = MONO_FONT;
      const totalWidth =
        total === '' ? 0 : context.measureText(total).width + 8;
      context.textAlign = 'left';
      context.font = LABEL_FONT;
      context.fillStyle = rgba(palette.label, 0.9);
      // Narrow canvases have no label column: names sit above their lane.
      if (layout.labelRight > 0) {
        context.fillText(
          this.#fit(lane.label, layout.labelRight - 16 - totalWidth),
          16,
          y + 4,
        );
        this.#drawTotal(total, layout.labelRight - 4, y + 4);
      } else
        context.fillText(
          this.#fit(
            total === '' ? lane.label : `${lane.label} · ${total}`,
            layout.right - layout.left,
          ),
          layout.left,
          y - 7,
        );
      context.strokeStyle = 'rgba(255,255,255,0.04)';
      context.beginPath();
      context.moveTo(layout.left, y);
      context.lineTo(layout.right, y);
      context.stroke();
    });
    const now = context.createLinearGradient(0, layout.top, 0, layout.bottom);
    now.addColorStop(0, rgba(palette.live, 0));
    now.addColorStop(0.5, rgba(palette.live, 0.5));
    now.addColorStop(1, rgba(palette.live, 0));
    context.strokeStyle = now;
    context.beginPath();
    context.moveTo(layout.right, layout.top - 10);
    context.lineTo(layout.right, layout.bottom + 4);
    context.stroke();
  }

  #drawTotal(total: string, right: number, y: number): void {
    if (total === '') return;
    const context = this.context;
    context.font = MONO_FONT;
    context.textAlign = 'right';
    context.fillStyle = rgba(this.#palette.muted, 0.85);
    context.fillText(total, right, y);
    context.textAlign = 'left';
    context.font = LABEL_FONT;
  }

  #fit(label: string, maxWidth: number): string {
    if (this.context.measureText(label).width <= maxWidth) return label;
    let fitted = label;
    while (
      fitted.length > 1 &&
      this.context.measureText(`${fitted}…`).width > maxWidth
    )
      fitted = fitted.slice(0, -1);
    return `${fitted}…`;
  }

  #drawLive(x0: number, x1: number, y: number): void {
    const context = this.context;
    const gradient = context.createLinearGradient(x0, 0, x1, 0);
    gradient.addColorStop(0, rgba(this.#palette.live, 0.18));
    gradient.addColorStop(1, rgba(this.#palette.tip, 1));
    context.strokeStyle = gradient;
    context.lineWidth = 2.4;
    context.shadowColor = rgba(this.#palette.live, 0.8);
    context.shadowBlur = 10;
    context.beginPath();
    context.moveTo(x0, y);
    context.lineTo(x1, y);
    context.stroke();
    context.shadowBlur = 0;
  }

  #drawRun(
    run: LoomRun,
    x0: number,
    x1: number,
    y: number,
    timeSeconds: number,
  ): void {
    const context = this.context;
    const color = toneColor(this.#palette, run.tone);
    const dashed = run.tone === 'waiting' || run.tone === 'queued';
    const dotted = run.tone === 'attention';
    context.strokeStyle = rgba(color, run.tone === 'success' ? 0.6 : 0.85);
    context.lineWidth = 2;
    context.setLineDash(dashed ? [3, 5] : dotted ? [1, 4] : []);
    context.beginPath();
    context.moveTo(x0, y);
    context.lineTo(x1, y);
    context.stroke();
    context.setLineDash([]);
    this.#drawEnd(run, color, x1, y, timeSeconds);
  }

  #drawEnd(
    run: LoomRun,
    color: Rgb,
    x: number,
    y: number,
    timeSeconds: number,
  ): void {
    const context = this.context;
    switch (run.tone) {
      case 'success': {
        context.fillStyle = rgba(color, 1);
        context.beginPath();
        context.arc(x, y, 3.3, 0, Math.PI * 2);
        context.fill();
        const landed = this.#landed.get(run.id);
        const age =
          landed === undefined
            ? 1
            : (performance.now() - landed) / KNOT_PULSE_MS;
        if (age < 1) {
          context.strokeStyle = rgba(color, 1 - age);
          context.lineWidth = 1.5;
          context.beginPath();
          context.arc(x, y, 3.3 + age * 12, 0, Math.PI * 2);
          context.stroke();
        }
        return;
      }
      case 'failure':
        // The thread stops at a cross.
        context.lineWidth = 1.6;
        context.beginPath();
        context.moveTo(x + 1.5, y - 3.5);
        context.lineTo(x + 8.5, y + 3.5);
        context.moveTo(x + 8.5, y - 3.5);
        context.lineTo(x + 1.5, y + 3.5);
        context.stroke();
        return;
      case 'timeout':
        context.lineWidth = 1.8;
        context.beginPath();
        context.moveTo(x + 2, y - 5);
        context.lineTo(x + 2, y + 5);
        context.stroke();
        return;
      case 'waiting': {
        const start = timeSeconds * 1.3;
        context.beginPath();
        context.arc(x, y, 5, start, start + Math.PI * 1.6);
        context.stroke();
        return;
      }
      case 'canceled':
        context.clearRect(x - 5, y - 3, 3, 6);
        return;
      default:
        return;
    }
  }

  #drawTips(
    layout: LoomLayout,
    tips: readonly (readonly [number, number])[],
    timeSeconds: number,
  ): void {
    const context = this.context;
    const palette = this.#palette;
    const { core } = layout;
    const targetX = core.x - core.radius * 0.8;
    context.globalCompositeOperation = 'lighter';
    tips.forEach(([x, y], index) => {
      const curve = [x, y, x + 60, y, targetX - 80, core.y, targetX, core.y];
      context.strokeStyle = rgba(palette.live, 0.12);
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x, y);
      context.bezierCurveTo(x + 60, y, targetX - 80, core.y, targetX, core.y);
      context.stroke();
      const progress = (timeSeconds * 0.5 + index * 0.37) % 1;
      const [px, py] = bezierPoint(curve, progress);
      context.fillStyle = rgba(palette.tip, Math.sin(Math.PI * progress) * 0.9);
      context.beginPath();
      context.arc(px, py, 2, 0, Math.PI * 2);
      context.fill();
      const pulse = 1 + 0.25 * Math.sin(timeSeconds * 5 + index);
      const glow = context.createRadialGradient(x, y, 0, x, y, 11 * pulse);
      glow.addColorStop(0, 'rgba(255,255,255,0.95)');
      glow.addColorStop(0.25, rgba(palette.tip, 0.8));
      glow.addColorStop(0.6, rgba(palette.live, 0.25));
      glow.addColorStop(1, rgba(palette.pending, 0));
      context.fillStyle = glow;
      context.beginPath();
      context.arc(x, y, 11 * pulse, 0, Math.PI * 2);
      context.fill();
    });
    context.globalCompositeOperation = 'source-over';
  }
}
