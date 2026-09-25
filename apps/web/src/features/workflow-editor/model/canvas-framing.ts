// Where the canvas is actually visible, and how to frame steps inside it.
// The editor's lenses float over the canvas, so "fit" and "show this step"
// work in the area between them rather than the whole viewport.

export type Box = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

type Edges = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;

export type Viewport = Readonly<{ x: number; y: number; zoom: number }>;

/** Lenses that float over the canvas carry this attribute. */
export const CANVAS_COVER_ATTRIBUTE = 'data-canvas-cover';

/**
 * Below this, step titles drop under 12px. A workflow too wide to fit at
 * this zoom starts at its left edge and pans for the rest.
 */
export const READABLE_ZOOM = 0.75;

/**
 * The canvas area no lens covers, in canvas coordinates. A lens taller than
 * half the canvas covers the side it sits on (the add-step and inspector
 * lenses); one wider than half covers the top or bottom (the command bar,
 * bottom sheets). Smaller lenses, like the zoom controls, are ignored.
 */
export function uncoveredArea(canvas: Edges, covers: readonly Edges[]): Box {
  const width = canvas.right - canvas.left;
  const height = canvas.bottom - canvas.top;
  let left = 0;
  let top = 0;
  let right = 0;
  let bottom = 0;
  for (const cover of covers) {
    const coverWidth = cover.right - cover.left;
    const coverHeight = cover.bottom - cover.top;
    if (coverWidth <= 0 || coverHeight <= 0) continue;
    const middleX = (cover.left + cover.right) / 2 - canvas.left;
    const middleY = (cover.top + cover.bottom) / 2 - canvas.top;
    if (coverHeight >= height / 2) {
      if (middleX < width / 2) left = Math.max(left, cover.right - canvas.left);
      else right = Math.max(right, canvas.right - cover.left);
    } else if (coverWidth >= width / 2) {
      if (middleY < height / 2) top = Math.max(top, cover.bottom - canvas.top);
      else bottom = Math.max(bottom, canvas.bottom - cover.top);
    }
  }
  return {
    x: left,
    y: top,
    width: Math.max(0, width - left - right),
    height: Math.max(0, height - top - bottom),
  };
}

/** `area` shrunk by `by` on every side, never below nothing. */
export function inset(area: Box, by: number): Box {
  const x = Math.min(by, area.width / 2);
  const y = Math.min(by, area.height / 2);
  return {
    x: area.x + x,
    y: area.y + y,
    width: area.width - x * 2,
    height: area.height - y * 2,
  };
}

/**
 * A viewport showing `bounds` (flow coordinates) inside `area` (canvas
 * coordinates): as large as fits, never above `maxZoom` and never below
 * `minZoom`, centred across and a third of the way down. When it doesn't fit at `minZoom`, the workflow's start (its
 * left edge, and its top if it's also too tall) is kept in view.
 */
export function framedViewport(
  bounds: Box,
  area: Box,
  limits: Readonly<{ minZoom: number; maxZoom: number }>,
): Viewport {
  const fitting = Math.min(
    area.width / Math.max(bounds.width, 1),
    area.height / Math.max(bounds.height, 1),
  );
  const zoom = Math.min(limits.maxZoom, Math.max(limits.minZoom, fitting));
  const shownWidth = bounds.width * zoom;
  const shownHeight = bounds.height * zoom;
  const left =
    shownWidth <= area.width ? area.x + (area.width - shownWidth) / 2 : area.x;
  // Nearer the top than the middle, as the blueprint draws it, which also
  // leaves the bottom free for the issues lens.
  const top =
    shownHeight <= area.height
      ? area.y + (area.height - shownHeight) / 3
      : area.y;
  return { x: left - bounds.x * zoom, y: top - bounds.y * zoom, zoom };
}

/**
 * The smallest pan (same zoom) that brings `target` (flow coordinates)
 * inside `area`, or undefined when it's already there. A target larger
 * than the area keeps its top-left corner in view.
 */
export function revealedViewport(
  target: Box,
  area: Box,
  viewport: Viewport,
): Viewport | undefined {
  const { zoom } = viewport;
  const left = target.x * zoom + viewport.x;
  const top = target.y * zoom + viewport.y;
  const dx = shift(left, left + target.width * zoom, area.x, area.width);
  const dy = shift(top, top + target.height * zoom, area.y, area.height);
  if (dx === 0 && dy === 0) return undefined;
  return { x: viewport.x + dx, y: viewport.y + dy, zoom };
}

function shift(start: number, end: number, from: number, size: number) {
  if (start < from) return from - start;
  if (end > from + size) return Math.max(from + size - end, from - start);
  return 0;
}
