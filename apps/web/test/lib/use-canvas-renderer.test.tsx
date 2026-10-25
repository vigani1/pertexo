import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useCanvasRenderer,
  type CanvasRenderer,
} from '../../src/lib/hooks/use-canvas-renderer';

class Recorder implements CanvasRenderer {
  public frames: number[] = [];
  public resize(): void {
    return undefined;
  }
  public render(timeSeconds: number): void {
    this.frames.push(timeSeconds);
  }
}

function mountCanvas(animate = true) {
  const recorder = new Recorder();
  const canvasRef = { current: document.createElement('canvas') };
  const hook = renderHook(
    ({ moving }: { moving: boolean }) =>
      useCanvasRenderer({
        canvasRef,
        createRenderer: () => recorder,
        animate: moving,
      }),
    { initialProps: { moving: animate } },
  );
  return { recorder, hook };
}

function deviceMatching(matching: string) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      /* This matchMedia recorder implements only matches and the listener methods used by the hook. */ ({
        matches: query === matching,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('canvas renderer loop', () => {
  it('draws thirty frames a second while it moves', () => {
    const { recorder } = mountCanvas();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(recorder.frames.length).toBeGreaterThanOrEqual(28);
    expect(recorder.frames.length).toBeLessThanOrEqual(32);
  });

  it('holds one still frame when motion is reduced', () => {
    deviceMatching('(prefers-reduced-motion: reduce)');
    const { recorder } = mountCanvas();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(recorder.frames).toEqual([3]);
  });

  it('moves on a touch-first device too', () => {
    deviceMatching('(pointer: coarse)');
    const { recorder } = mountCanvas();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(recorder.frames.length).toBeGreaterThanOrEqual(28);
  });

  it('keeps moving in a visible window without focus', () => {
    const { recorder } = mountCanvas();
    act(() => {
      window.dispatchEvent(new Event('blur'));
      vi.advanceTimersByTime(1000);
    });
    expect(recorder.frames.length).toBeGreaterThanOrEqual(28);
  });

  it('pauses while its tab is hidden', () => {
    const { recorder } = mountCanvas();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => {
      vi.advanceTimersByTime(200);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const before = recorder.frames.length;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(recorder.frames).toHaveLength(before);
    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(200);
    });
    expect(recorder.frames.length).toBeGreaterThan(before);
  });

  it('keeps the last frame when it stops and redraws that frame on refresh', () => {
    const { recorder, hook } = mountCanvas(false);
    expect(recorder.frames).toEqual([3]);
    act(() => {
      hook.result.current.refresh();
    });
    expect(recorder.frames).toEqual([3, 3]);

    hook.rerender({ moving: true });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    hook.rerender({ moving: false });
    const last = recorder.frames.at(-1);
    const count = recorder.frames.length;
    act(() => {
      vi.advanceTimersByTime(1000);
      hook.result.current.refresh();
    });
    expect(recorder.frames).toHaveLength(count + 1);
    expect(recorder.frames.at(-1)).toBe(last);
  });
});
