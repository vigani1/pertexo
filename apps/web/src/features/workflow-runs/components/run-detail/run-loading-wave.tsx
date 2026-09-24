import { useRef } from 'react';
import { useCanvasRenderer } from '@/lib/use-canvas-renderer';
import { LoadingWaveRenderer } from './loading-wave-renderer';

/** A ripple across a dot grid while a run has no steps to show yet. */
export function RunLoadingWave() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useCanvasRenderer(canvasRef, (canvas) => new LoadingWaveRenderer(canvas));
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full"
    />
  );
}
