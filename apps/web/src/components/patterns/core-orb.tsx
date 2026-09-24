import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useCanvasRenderer } from '@/lib/use-canvas-renderer';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import { CoreOrbScene, type CoreOrbState } from './core-orb-scene';

export type { CoreOrbState };

/**
 * The Core: Pertexo's living orb. Decorative only; callers pair it with a
 * visible status sentence. `energy` (0.2–1.6) follows live work, `assemble`
 * gathers scattered particles into the sphere once on mount.
 */
export function CoreOrb({
  state = 'live',
  energy = 1,
  assemble = false,
  className,
}: Readonly<{
  state?: CoreOrbState;
  energy?: number;
  assemble?: boolean;
  className?: string;
}>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const sceneRef = useCanvasRenderer(canvasRef, (canvas) => {
    const scene = new CoreOrbScene(canvas, state);
    scene.setEnergy(energy);
    return scene;
  });

  useEffect(() => {
    sceneRef.current?.setState(state);
  }, [sceneRef, state]);

  useEffect(() => {
    sceneRef.current?.setEnergy(energy);
  }, [sceneRef, energy]);

  useEffect(() => {
    if (assemble && !reducedMotion)
      sceneRef.current?.assemble(performance.now() / 1000);
  }, [sceneRef, assemble, reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      data-slot="core-orb"
      data-state={state}
      aria-hidden="true"
      className={cn('pointer-events-none block', className)}
    />
  );
}
