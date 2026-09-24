import type { CanvasRenderer } from '@/lib/use-canvas-renderer';
import { CanvasSurface, readTokenColors, type Rgb } from '../canvas-surface';

// A ripple travelling across a dot grid while a run waits for its first
// step. Colours come from the theme tokens; the hook owns the loop.

const GRID_GAP = 24;
const BASE_DOT_RADIUS = 1;
const WAVE_SECONDS = 3.4;
const WAVE_WIDTH = 82;
const WAVE_HEIGHT = 11;
const TOKENS = {
  rest: ['--primary', [0, 229, 255]],
  crest: ['--accent-foreground', [195, 245, 255]],
} as const;

function smoothstep(edgeStart: number, edgeEnd: number, value: number) {
  const progress = Math.min(
    1,
    Math.max(0, (value - edgeStart) / (edgeEnd - edgeStart)),
  );
  return progress * progress * (3 - 2 * progress);
}

function mix(from: Rgb, to: Rgb, amount: number): string {
  return from
    .map((channel, index) =>
      String(Math.round(channel + ((to[index] ?? channel) - channel) * amount)),
    )
    .join(',');
}

export class LoadingWaveRenderer implements CanvasRenderer {
  readonly #surface: CanvasSurface;
  readonly #colors: Readonly<Record<keyof typeof TOKENS, Rgb>>;

  public constructor(canvas: HTMLCanvasElement) {
    this.#surface = new CanvasSurface(canvas);
    this.#colors = readTokenColors(TOKENS);
  }

  public resize(width: number, height: number, pixelRatio: number): void {
    this.#surface.resize(width, height, pixelRatio);
  }

  public render(timeSeconds: number): void {
    const context = this.#surface.beginFrame();
    const { width, height } = this.#surface;
    const progress = (timeSeconds % WAVE_SECONDS) / WAVE_SECONDS;
    const centreX = width / 2;
    const centreY = height / 2;
    const crestRadius = progress * (Math.hypot(centreX, centreY) + WAVE_WIDTH);
    const opacity =
      smoothstep(0, 0.08, progress) * (1 - smoothstep(0.86, 1, progress));
    const xOffset = (width % GRID_GAP) / 2;
    const yOffset = (height % GRID_GAP) / 2;
    for (let y = yOffset; y <= height; y += GRID_GAP) {
      for (let x = xOffset; x <= width; x += GRID_GAP) {
        const distance = Math.hypot(x - centreX, y - centreY) - crestRadius;
        const normalized = distance / WAVE_WIDTH;
        const wave =
          Math.abs(distance) > WAVE_WIDTH
            ? 0
            : Math.cos(normalized * Math.PI * 2.35) *
              Math.exp(-normalized * normalized * 3.2) *
              opacity;
        const crest = Math.max(0, wave);
        const radius = Math.max(
          0.75,
          BASE_DOT_RADIUS + crest * 0.75 - Math.max(0, -wave) * 0.15,
        );
        context.beginPath();
        context.arc(x, y - wave * WAVE_HEIGHT, radius, 0, Math.PI * 2);
        context.fillStyle = `rgba(${mix(this.#colors.rest, this.#colors.crest, crest)},${String(
          0.12 + Math.abs(wave) * 0.58,
        )})`;
        context.fill();
      }
    }
  }
}
