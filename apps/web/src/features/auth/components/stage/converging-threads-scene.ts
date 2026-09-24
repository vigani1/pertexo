import type { CanvasRenderer } from '@/lib/use-canvas-renderer';

// The weave moment behind the sign-in family: faint threads run in from the
// edges of the screen and particles of light travel along them into the Core.
// Pure drawing code; the React component owns the canvas lifecycle.

export type ThreadTarget = Readonly<{ x: number; y: number; radius: number }>;

type Point = readonly [number, number];

interface Thread {
  /** Cubic bezier: start, two controls, end at the Core's rim. */
  readonly path: readonly [Point, Point, Point, Point];
  readonly sprite: HTMLCanvasElement | undefined;
  readonly rgb: string;
  readonly speed: number;
  readonly offset: number;
}

const THREAD_COUNT = 30;
const PARTICLES_PER_THREAD = 2;
const TRAIL_STEPS = 5;
const COLOR_TOKENS = ['--primary', '--secondary', '--accent-foreground'];
const FALLBACK_RGB = '0,229,255';

function tokenRgb(styles: CSSStyleDeclaration, token: string): string {
  const match = /^#?([\da-f]{6})$/i.exec(styles.getPropertyValue(token).trim());
  if (match?.[1] === undefined) return FALLBACK_RGB;
  const value = Number.parseInt(match[1], 16);
  return `${String((value >> 16) & 255)},${String((value >> 8) & 255)},${String(value & 255)}`;
}

function glowSprite(rgb: string): HTMLCanvasElement | undefined {
  const sprite = document.createElement('canvas');
  sprite.width = 32;
  sprite.height = 32;
  const context = sprite.getContext('2d');
  if (context === null) return undefined;
  const glow = context.createRadialGradient(16, 16, 0, 16, 16, 16);
  glow.addColorStop(0, `rgba(${rgb},1)`);
  glow.addColorStop(0.25, `rgba(${rgb},0.55)`);
  glow.addColorStop(1, `rgba(${rgb},0)`);
  context.fillStyle = glow;
  context.fillRect(0, 0, 32, 32);
  return sprite;
}

/** A small deterministic generator so threads keep their shape on resize. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
}

function pointOnPath(
  [start, first, second, end]: Thread['path'],
  progress: number,
): Point {
  const rest = 1 - progress;
  const a = rest * rest * rest;
  const b = 3 * rest * rest * progress;
  const c = 3 * rest * progress * progress;
  const d = progress * progress * progress;
  return [
    a * start[0] + b * first[0] + c * second[0] + d * end[0],
    a * start[1] + b * first[1] + c * second[1] + d * end[1],
  ];
}

function edgeStart(
  index: number,
  width: number,
  height: number,
  random: () => number,
): Point {
  const side = index % 4;
  if (side === 0) return [-20, random() * height];
  if (side === 1) return [width + 20, random() * height];
  if (side === 2) return [random() * width, -20];
  return [random() * width, height + 20];
}

export class ConvergingThreadsScene implements CanvasRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #locateTarget: (width: number, height: number) => ThreadTarget;
  readonly #palette: readonly {
    rgb: string;
    sprite: HTMLCanvasElement | undefined;
  }[];
  #threads: Thread[] = [];
  #target: ThreadTarget = { x: 0, y: 0, radius: 0 };
  #width = 0;
  #height = 0;
  #pixelRatio = 1;

  constructor(
    canvas: HTMLCanvasElement,
    locateTarget: (width: number, height: number) => ThreadTarget,
  ) {
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Canvas 2D is unavailable');
    this.#canvas = canvas;
    this.#context = context;
    this.#locateTarget = locateTarget;
    const styles = getComputedStyle(document.documentElement);
    this.#palette = COLOR_TOKENS.map((token) => {
      const rgb = tokenRgb(styles, token);
      return { rgb, sprite: glowSprite(rgb) };
    });
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.#width = width;
    this.#height = height;
    this.#pixelRatio = pixelRatio;
    this.#canvas.width = Math.max(1, Math.round(width * pixelRatio));
    this.#canvas.height = Math.max(1, Math.round(height * pixelRatio));
    this.#target = this.#locateTarget(width, height);
    this.#threads = this.#weave();
  }

  #weave(): Thread[] {
    const random = seededRandom(7);
    const { x, y, radius } = this.#target;
    return Array.from({ length: THREAD_COUNT }, (_, index) => {
      const start = edgeStart(index, this.#width, this.#height, random);
      const angle = Math.atan2(start[1] - y, start[0] - x);
      const end: Point = [
        x + Math.cos(angle) * radius * 0.95,
        y + Math.sin(angle) * radius * 0.95,
      ];
      const bend = (random() - 0.5) * radius * 2.2;
      const normal: Point = [-Math.sin(angle), Math.cos(angle)];
      const along = (share: number): Point => [
        start[0] + (end[0] - start[0]) * share,
        start[1] + (end[1] - start[1]) * share,
      ];
      const [firstX, firstY] = along(0.35);
      const [secondX, secondY] = along(0.75);
      const swatch = this.#palette[index % this.#palette.length];
      return {
        path: [
          start,
          [firstX + normal[0] * bend, firstY + normal[1] * bend],
          [secondX - normal[0] * bend * 0.4, secondY - normal[1] * bend * 0.4],
          end,
        ],
        rgb: swatch?.rgb ?? FALLBACK_RGB,
        sprite: swatch?.sprite,
        speed: 0.05 + random() * 0.07,
        offset: random(),
      };
    });
  }

  render(timeSeconds: number): void {
    const context = this.#context;
    context.setTransform(this.#pixelRatio, 0, 0, this.#pixelRatio, 0, 0);
    context.clearRect(0, 0, this.#width, this.#height);
    this.#drawHalo();
    context.lineWidth = 1;
    for (const thread of this.#threads) {
      const [start, first, second, end] = thread.path;
      context.strokeStyle = `rgba(${thread.rgb},0.07)`;
      context.beginPath();
      context.moveTo(start[0], start[1]);
      context.bezierCurveTo(
        first[0],
        first[1],
        second[0],
        second[1],
        end[0],
        end[1],
      );
      context.stroke();
      this.#drawParticles(thread, timeSeconds);
    }
  }

  #drawHalo(): void {
    const { x, y, radius } = this.#target;
    const [primary, secondary] = this.#palette;
    const halo = this.#context.createRadialGradient(
      x,
      y,
      0,
      x,
      y,
      radius * 2.4,
    );
    halo.addColorStop(0, `rgba(${primary?.rgb ?? FALLBACK_RGB},0.1)`);
    halo.addColorStop(0.5, `rgba(${secondary?.rgb ?? FALLBACK_RGB},0.04)`);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    this.#context.fillStyle = halo;
    this.#context.fillRect(0, 0, this.#width, this.#height);
  }

  #drawParticles(thread: Thread, timeSeconds: number): void {
    const { sprite } = thread;
    if (sprite === undefined) return;
    const context = this.#context;
    context.globalCompositeOperation = 'lighter';
    for (let particle = 0; particle < PARTICLES_PER_THREAD; particle += 1) {
      const progress =
        (((timeSeconds * thread.speed +
          thread.offset +
          particle / PARTICLES_PER_THREAD) %
          1) +
          1) %
        1;
      const alpha = Math.sin(Math.PI * progress) * 0.85;
      const size = 2 + progress * 3.5;
      for (let step = 0; step <= TRAIL_STEPS; step += 1) {
        const behind = progress - step * 0.012;
        if (behind < 0) break;
        const [px, py] = pointOnPath(thread.path, behind);
        const scale = step === 0 ? 2 : 1.5 * (1 - step / 8);
        context.globalAlpha = step === 0 ? alpha : alpha * (1 - step / 6) * 0.6;
        context.drawImage(
          sprite,
          px - size * scale,
          py - size * scale,
          size * scale * 2,
          size * scale * 2,
        );
      }
    }
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
  }
}
