import { useEffect, useEffectEvent, useRef, type RefObject } from 'react';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

export interface CanvasRenderer {
  resize(width: number, height: number, pixelRatio: number): void;
  render(timeSeconds: number, deltaSeconds: number): void;
}

const MAX_PIXEL_RATIO = 2;
// Reduced motion renders one representative still frame instead of a loop.
const STILL_FRAME_SECONDS = 3;

/**
 * Drives a canvas renderer for decorative animation: keeps the backing store
 * matched to the element's size and pixel density, animates only while the
 * canvas is on screen and the tab is visible, and draws a single still frame
 * when reduced motion is requested. The renderer is created once per mount.
 */
export function useCanvasRenderer<Renderer extends CanvasRenderer>(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  createRenderer: (canvas: HTMLCanvasElement) => Renderer,
): RefObject<Renderer | null> {
  const rendererRef = useRef<Renderer | null>(null);
  // Reads the caller's latest props when the renderer is (re)created.
  const create = useEffectEvent(createRenderer);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let renderer: Renderer;
    try {
      renderer = create(canvas);
    } catch {
      return; // Decorative only: an unavailable canvas context renders nothing.
    }
    rendererRef.current = renderer;

    let visible = true;
    let frame = 0;
    let previous = performance.now();

    const drawStill = () => {
      renderer.render(STILL_FRAME_SECONDS, 0);
    };
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      renderer.resize(
        bounds.width,
        bounds.height,
        Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO),
      );
      if (reducedMotion) drawStill();
    };
    const tick = (now: number) => {
      frame = 0;
      if (!visible || document.hidden) return;
      renderer.render(now / 1000, Math.min((now - previous) / 1000, 0.1));
      previous = now;
      frame = window.requestAnimationFrame(tick);
    };
    const start = () => {
      if (reducedMotion || frame !== 0 || !visible || document.hidden) return;
      previous = performance.now();
      frame = window.requestAnimationFrame(tick);
    };

    resize();
    if (reducedMotion) drawStill();
    start();

    const resizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    resizeObserver?.observe(canvas);
    const intersectionObserver =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(([entry]) => {
            visible = entry?.isIntersecting ?? true;
            start();
          })
        : null;
    intersectionObserver?.observe(canvas);
    document.addEventListener('visibilitychange', start);

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      document.removeEventListener('visibilitychange', start);
      rendererRef.current = null;
    };
  }, [canvasRef, reducedMotion]);

  return rendererRef;
}
