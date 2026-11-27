import { rgba, type Rgb } from '@/lib/canvas-scene';
import type { LoomLayout } from './model';

/** Draws a single run thread fading inside the Core shell. */
export function drawCoreThread(
  context: CanvasRenderingContext2D,
  layout: LoomLayout,
  from: Readonly<{ x: number; y: number }>,
  ink: Readonly<{ color: Rgb; alpha: number }>,
) {
  const { x, y } = from;
  const { color, alpha } = ink;
  const { core } = layout;
  const targetX = core.x - core.radius * 0.18;
  const bend = (targetX - x) * 0.48;
  const curve = [
    x,
    y,
    x + bend,
    y,
    targetX - bend,
    core.y,
    targetX,
    core.y,
  ] as const;
  const fade = context.createLinearGradient(x, 0, targetX, 0);
  fade.addColorStop(0, rgba(color, alpha));
  // The thread enters the shell before it fades into the centre.
  const shell = Math.min(
    1,
    Math.max(0, (core.x - core.radius - x) / (targetX - x || 1)),
  );
  fade.addColorStop(shell, rgba(color, alpha * 0.65));
  fade.addColorStop(1, rgba(color, 0));
  context.strokeStyle = fade;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(x, y);
  context.bezierCurveTo(x + bend, y, targetX - bend, core.y, targetX, core.y);
  context.stroke();
  return curve;
}

export function bezierPoint(
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
