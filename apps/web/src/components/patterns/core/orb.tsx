import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import {
  useCanvasRenderer,
  useStillCanvases,
} from '@/lib/hooks/use-canvas-renderer';
import { CoreOrbScene, type CoreOrbState } from './orb-scene';

export type { CoreOrbState };

/** The energy of a Core with nothing running: a slow, calm drift. */
export const CORE_IDLE_ENERGY = 0.3;

/**
 * The Core: Pertexo's living orb. Decorative only; callers pair it with a
 * visible status sentence. It always drifts; `energy` (0.2–1.6) follows live
 * work, so an idle Core turns slowly and a busy one quickens and brightens.
 * `assemble` gathers scattered particles into the sphere once on mount.
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
  const deviceStill = useStillCanvases();
  const { renderer: sceneRef, refresh } = useCanvasRenderer({
    canvasRef,
    createRenderer: (canvas) => {
      const scene = new CoreOrbScene(canvas, state);
      scene.setEnergy(energy);
      return scene;
    },
  });

  useEffect(() => {
    sceneRef.current?.setState(state);
    refresh();
  }, [sceneRef, refresh, state]);

  useEffect(() => {
    sceneRef.current?.setEnergy(energy);
    refresh();
  }, [sceneRef, refresh, energy]);

  useEffect(() => {
    if (assemble && !deviceStill)
      sceneRef.current?.assemble(performance.now() / 1000);
  }, [sceneRef, assemble, deviceStill]);

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
