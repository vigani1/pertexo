import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  type RefObject,
} from 'react';
import { useMediaQuery } from './use-media-query';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

export interface CanvasRenderer {
  resize(width: number, height: number, pixelRatio: number): void;
  render(timeSeconds: number, deltaSeconds: number): void;
}

const MAX_PIXEL_RATIO = 2;
// A canvas that never moved shows this moment as its representative frame.
const STILL_FRAME_SECONDS = 3;
// The drawings move slowly, so 30 frames a second looks like 60 and halves
// the work: every frame makes the browser repaint and composite the window.
const FRAME_INTERVAL_MS = 1000 / 30;
// Display frames land a little early or late; this keeps 60 Hz at every
// second frame instead of skipping to every third.
const FRAME_SLACK_MS = 2;

/**
 * Whether decorative drawings hold still on this device: the person asked to
 * minimise motion, or the device is touch-first, where heat and battery
 * matter more than motion.
 */
export function useStillCanvases(): boolean {
  const reducedMotion = usePrefersReducedMotion();
  const touchFirst = useMediaQuery('(pointer: coarse)');
  return reducedMotion || touchFirst;
}

export type CanvasHandle<Renderer> = Readonly<{
  renderer: RefObject<Renderer | null>;
  /**
   * Redraw after changing what the renderer shows. A moving canvas picks the
   * change up on its next frame; a still one redraws now.
   */
  refresh: () => void;
}>;

/**
 * Drives a canvas renderer for decorative animation: keeps the backing store
 * matched to the element's size and pixel density, and animates at 30 frames
 * a second only while `animate` holds, the canvas is on screen, its window
 * has focus and the device isn't one that holds drawings still. Otherwise
 * the canvas keeps its last frame. The renderer is created once per mount.
 */
export function useCanvasRenderer<Renderer extends CanvasRenderer>(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  createRenderer: (canvas: HTMLCanvasElement) => Renderer,
  animate = true,
): CanvasHandle<Renderer> {
  const rendererRef = useRef<Renderer | null>(null);
  const loopRef = useRef<Readonly<{
    update: () => void;
    refresh: () => void;
  }> | null>(null);
  // Reads the caller's latest props when the renderer is (re)created.
  const create = useEffectEvent(createRenderer);
  const still = useStillCanvases() || !animate;
  const isStill = useEffectEvent(() => still);

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
    let focused = document.hasFocus();
    let frame = 0;
    let previous = 0;
    // The moment on screen, so a canvas that stops can redraw the same frame.
    let shown = STILL_FRAME_SECONDS;

    const moving = () => !isStill() && visible && focused && !document.hidden;
    const draw = (timeSeconds: number, deltaSeconds: number) => {
      renderer.render(timeSeconds, deltaSeconds);
      shown = timeSeconds;
    };
    const tick = (now: number) => {
      frame = 0;
      if (!moving()) return;
      if (now - previous >= FRAME_INTERVAL_MS - FRAME_SLACK_MS) {
        draw(now / 1000, Math.min((now - previous) / 1000, 0.1));
        previous = now;
      }
      frame = window.requestAnimationFrame(tick);
    };
    const update = () => {
      if (!moving()) {
        if (frame !== 0) window.cancelAnimationFrame(frame);
        frame = 0;
        return;
      }
      if (frame !== 0) return;
      previous = performance.now() - FRAME_INTERVAL_MS;
      frame = window.requestAnimationFrame(tick);
    };
    const refresh = () => {
      if (!moving()) draw(shown, 0);
    };
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      renderer.resize(
        bounds.width,
        bounds.height,
        Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO),
      );
      // Resizing clears the canvas; a moving one redraws on its next frame.
      refresh();
    };
    const focus = () => {
      focused = true;
      update();
    };
    const blur = () => {
      focused = false;
      update();
    };
    loopRef.current = { update, refresh };

    resize();
    update();

    const resizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    resizeObserver?.observe(canvas);
    const intersectionObserver =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(([entry]) => {
            visible = entry?.isIntersecting ?? true;
            update();
          })
        : null;
    intersectionObserver?.observe(canvas);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', focus);
    window.addEventListener('blur', blur);

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', focus);
      window.removeEventListener('blur', blur);
      rendererRef.current = null;
      loopRef.current = null;
    };
  }, [canvasRef]);

  useEffect(() => {
    loopRef.current?.update();
  }, [still]);

  const refresh = useCallback(() => {
    loopRef.current?.refresh();
  }, []);
  return { renderer: rendererRef, refresh };
}
