import type { CanvasRenderer } from './use-canvas-renderer';

// The shared plumbing of every Canvas 2D drawing (the Core, the sign-in
// threads, the Loom, the loading wave): a context whose backing store follows
// its element's size and pixel density, and theme colours read from the
// design tokens so drawings follow the theme. `useCanvasRenderer` owns the
// loop; a scene only draws frames.

export type Rgb = readonly [number, number, number];

function parseHexColor(value: string): Rgb | undefined {
  const match = /^#?([\da-f]{6})$/iu.exec(value.trim());
  if (match?.[1] === undefined) return undefined;
  const numeric = Number.parseInt(match[1], 16);
  return [(numeric >> 16) & 255, (numeric >> 8) & 255, numeric & 255];
}

/** One `--token` colour from the root element, or `fallback`. */
export function readTokenColor(token: string, fallback: Rgb): Rgb {
  const styles = getComputedStyle(document.documentElement);
  return parseHexColor(styles.getPropertyValue(token)) ?? fallback;
}

/** Several `--token` colours at once, each with its fallback. */
export function readTokenColors<Name extends string>(
  tokens: Readonly<Record<Name, readonly [token: string, fallback: Rgb]>>,
): Record<Name, Rgb> {
  const entries = Object.entries(tokens) as [Name, readonly [string, Rgb]][];
  return Object.fromEntries(
    entries.map(([name, [token, fallback]]) => [
      name,
      readTokenColor(token, fallback),
    ]),
  ) as Record<Name, Rgb>;
}

export function rgba(color: Rgb, alpha: number): string {
  return `rgba(${color.join(',')},${String(alpha)})`;
}

/** A Canvas 2D drawing sized in CSS pixels; subclasses draw each frame. */
export abstract class CanvasScene implements CanvasRenderer {
  protected readonly context: CanvasRenderingContext2D;
  protected width = 0;
  protected height = 0;
  readonly #canvas: HTMLCanvasElement;
  #pixelRatio = 1;

  protected constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Canvas 2D is unavailable.');
    this.#canvas = canvas;
    this.context = context;
  }

  public resize(width: number, height: number, pixelRatio: number): void {
    this.width = width;
    this.height = height;
    this.#pixelRatio = pixelRatio;
    this.#canvas.width = Math.max(1, Math.round(width * pixelRatio));
    this.#canvas.height = Math.max(1, Math.round(height * pixelRatio));
  }

  public abstract render(timeSeconds: number, deltaSeconds: number): void;

  /** Starts a frame in CSS pixels on a cleared canvas. */
  protected beginFrame(): CanvasRenderingContext2D {
    this.context.setTransform(this.#pixelRatio, 0, 0, this.#pixelRatio, 0, 0);
    this.context.clearRect(0, 0, this.width, this.height);
    return this.context;
  }
}
