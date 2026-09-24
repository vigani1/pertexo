// The shared plumbing of the runs feature's canvases (the Loom and the
// loading wave): a 2D context sized to its element's pixel density, and
// theme colours read from the design tokens so drawings follow the theme.

export type Rgb = readonly [number, number, number];

function parseHex(value: string): Rgb | undefined {
  const match = /^#?([\da-f]{6})$/iu.exec(value.trim());
  if (match?.[1] === undefined) return undefined;
  const numeric = Number.parseInt(match[1], 16);
  return [(numeric >> 16) & 255, (numeric >> 8) & 255, numeric & 255];
}

/** Reads `--token` colours from the root element, with a fallback each. */
export function readTokenColors<Name extends string>(
  tokens: Readonly<Record<Name, readonly [token: string, fallback: Rgb]>>,
): Record<Name, Rgb> {
  const styles = getComputedStyle(document.documentElement);
  const entries = Object.entries(tokens) as [Name, readonly [string, Rgb]][];
  return Object.fromEntries(
    entries.map(([name, [token, fallback]]) => [
      name,
      parseHex(styles.getPropertyValue(token)) ?? fallback,
    ]),
  ) as Record<Name, Rgb>;
}

export function rgba(color: Rgb, alpha: number): string {
  return `rgba(${color.join(',')},${String(alpha)})`;
}

export class CanvasSurface {
  readonly #canvas: HTMLCanvasElement;
  public readonly context: CanvasRenderingContext2D;
  public width = 0;
  public height = 0;
  #pixelRatio = 1;

  public constructor(canvas: HTMLCanvasElement) {
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

  /** Starts a frame in CSS pixels on a cleared canvas. */
  public beginFrame(): CanvasRenderingContext2D {
    this.context.setTransform(this.#pixelRatio, 0, 0, this.#pixelRatio, 0, 0);
    this.context.clearRect(0, 0, this.width, this.height);
    return this.context;
  }
}
