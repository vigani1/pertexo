import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import {
  useCanvasRenderer,
  useStillCanvases,
} from '@/lib/hooks/use-canvas-renderer';
import { CoreOrbScene, type CoreOrbState } from './orb-scene';

export type { CoreOrbState };

/**
 * The Core: Pertexo's living orb. Decorative only; callers pair it with a
 * visible status sentence. `energy` (0.2–1.6) follows live work, `assemble`
 * gathers scattered particles into the sphere once on mount. A Core that
 * reports status passes `still` while nothing is running, so it moves only
 * when that means something.
 */
export function CoreOrb({
  state = 'live',
  energy = 1,
  assemble = false,
  still = false,
  className,
}: Readonly<{
  state?: CoreOrbState;
  energy?: number;
  assemble?: boolean;
  still?: boolean;
  className?: string;
}>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const deviceStill = useStillCanvases();
  const { renderer: sceneRef, refresh } = useCanvasRenderer(
    canvasRef,
    (canvas) => {
      const scene = new CoreOrbScene(canvas, state);
      scene.setEnergy(energy);
      return scene;
    },
    !still,
  );

  useEffect(() => {
    sceneRef.current?.setState(state);
    refresh();
  }, [sceneRef, refresh, state]);

  useEffect(() => {
    sceneRef.current?.setEnergy(energy);
    refresh();
  }, [sceneRef, refresh, energy]);

  useEffect(() => {
    if (assemble && !still && !deviceStill)
      sceneRef.current?.assemble(performance.now() / 1000);
  }, [sceneRef, assemble, still, deviceStill]);

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
