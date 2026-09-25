import { describe, expect, it } from 'vitest';
import {
  framedViewport,
  inset,
  revealedViewport,
  uncoveredArea,
} from '@/features/workflow-editor/model/canvas-framing';

const canvas = { left: 0, top: 0, right: 1440, bottom: 900 };
const commandBar = { left: 12, top: 12, right: 1428, bottom: 74 };
const addStepLens = { left: 12, top: 82, right: 264, bottom: 888 };
const inspector = { left: 1084, top: 82, right: 1428, bottom: 888 };
const zoomLens = { left: 272, top: 794, right: 438, bottom: 888 };

describe('editor canvas framing', () => {
  it('finds the area between the lenses, ignoring small ones', () => {
    expect(
      uncoveredArea(canvas, [commandBar, addStepLens, inspector, zoomLens]),
    ).toEqual({ x: 264, y: 74, width: 820, height: 826 });
    expect(uncoveredArea(canvas, [])).toEqual({
      x: 0,
      y: 0,
      width: 1440,
      height: 900,
    });
    // A hidden lens has no size and covers nothing.
    expect(
      uncoveredArea(canvas, [{ left: 0, top: 0, right: 0, bottom: 0 }]),
    ).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  });

  it('fits a workflow into the area, centred, but never below a readable zoom', () => {
    const area = { x: 264, y: 74, width: 1176, height: 826 };
    const small = framedViewport(
      { x: 0, y: 0, width: 600, height: 200 },
      area,
      { minZoom: 0.75, maxZoom: 1 },
    );
    expect(small).toEqual({ x: 552, y: 387, zoom: 1 });

    const wide = framedViewport(
      { x: 100, y: 40, width: 4000, height: 400 },
      area,
      { minZoom: 0.75, maxZoom: 1 },
    );
    expect(wide.zoom).toBe(0.75);
    // Too wide: the workflow's start sits at the area's left edge.
    expect(wide.x).toBe(264 - 100 * 0.75);
  });

  it('pans a step hidden under a lens into view and leaves visible ones alone', () => {
    const area = inset({ x: 264, y: 74, width: 820, height: 826 }, 24);
    const viewport = { x: 0, y: 0, zoom: 1 };
    expect(
      revealedViewport(
        { x: 400, y: 200, width: 224, height: 64 },
        area,
        viewport,
      ),
    ).toBeUndefined();
    expect(
      revealedViewport(
        { x: 1100, y: 200, width: 224, height: 64 },
        area,
        viewport,
      ),
    ).toEqual({ x: 1060 - 1324, y: 0, zoom: 1 });
    expect(
      revealedViewport({ x: 100, y: 20, width: 224, height: 64 }, area, {
        x: 0,
        y: 0,
        zoom: 0.5,
      }),
    ).toEqual({ x: 288 - 50, y: 98 - 10, zoom: 0.5 });
  });
});
