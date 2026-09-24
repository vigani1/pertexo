import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CanvasScene,
  readTokenColor,
  readTokenColors,
  rgba,
} from '../../src/lib/canvas-scene';

class Dots extends CanvasScene {
  public frames: { width: number; height: number }[] = [];
  public constructor(canvas: HTMLCanvasElement) {
    super(canvas);
  }
  public render(): void {
    this.beginFrame();
    this.frames.push({ width: this.width, height: this.height });
  }
}

afterEach(() => {
  document.documentElement.style.removeProperty('--primary');
  vi.restoreAllMocks();
});

describe('canvas scenes', () => {
  it('reads theme colours from tokens, with a fallback', () => {
    document.documentElement.style.setProperty('--primary', '#00e5ff');
    expect(readTokenColor('--primary', [1, 2, 3])).toEqual([0, 229, 255]);
    expect(readTokenColor('--missing', [1, 2, 3])).toEqual([1, 2, 3]);
    expect(
      readTokenColors({ live: ['--primary', [0, 0, 0]] as const }),
    ).toEqual({ live: [0, 229, 255] });
    expect(rgba([0, 229, 255], 0.5)).toBe('rgba(0,229,255,0.5)');
  });

  it('sizes the backing store to the pixel ratio and clears each frame in CSS pixels', () => {
    const setTransform = vi.fn();
    const clearRect = vi.fn();
    const context = {
      setTransform,
      clearRect,
    } as unknown as CanvasRenderingContext2D;
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(context);
    const scene = new Dots(canvas);
    scene.resize(120.4, 40, 2);
    expect(canvas.width).toBe(241);
    expect(canvas.height).toBe(80);
    scene.render();
    expect(setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(clearRect).toHaveBeenCalledWith(0, 0, 120.4, 40);
    expect(scene.frames).toEqual([{ width: 120.4, height: 40 }]);
  });

  it('refuses a canvas without a 2D context', () => {
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(null);
    expect(() => new Dots(canvas)).toThrow('Canvas 2D is unavailable.');
  });
});
