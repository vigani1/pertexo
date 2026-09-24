import { useRef, type RefObject } from 'react';
import { useCanvasRenderer } from '@/lib/use-canvas-renderer';
import { cn } from '@/lib/utils';
import {
  ConvergingThreadsScene,
  type ThreadTarget,
} from './converging-threads-scene';

// The Core draws its sphere at 36% of its canvas's shorter side.
const CORE_RADIUS_SHARE = 0.36;

function locateCore(
  canvas: HTMLCanvasElement,
  core: HTMLElement | null,
  width: number,
  height: number,
): ThreadTarget {
  if (core === null)
    return {
      x: width * 0.34,
      y: height / 2,
      radius: Math.min(width, height) * 0.24,
    };
  const frame = canvas.getBoundingClientRect();
  const bounds = core.getBoundingClientRect();
  return {
    x: bounds.left + bounds.width / 2 - frame.left,
    y: bounds.top + bounds.height / 2 - frame.top,
    radius: Math.min(bounds.width, bounds.height) * CORE_RADIUS_SHARE,
  };
}

/**
 * Threads that flow from the screen's edges into the Core. Decorative: it
 * pauses off-screen and in hidden tabs and draws one still frame under
 * reduced motion.
 */
export function ConvergingThreads({
  coreRef,
  className,
}: Readonly<{
  coreRef: RefObject<HTMLElement | null>;
  className?: string;
}>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useCanvasRenderer(
    canvasRef,
    (canvas) =>
      new ConvergingThreadsScene(canvas, (width, height) =>
        locateCore(canvas, coreRef.current, width, height),
      ),
  );
  return (
    <canvas
      ref={canvasRef}
      data-slot="converging-threads"
      aria-hidden="true"
      className={cn('pointer-events-none block', className)}
    />
  );
}
