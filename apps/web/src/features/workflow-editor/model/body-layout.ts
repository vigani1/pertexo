import { stepDepths } from './graph-order';
import {
  isForEach,
  levelAt,
  scopeOf,
  type GraphLevel,
  type ScopePath,
  type WorkflowNode,
} from './graph-scopes';

// Where a For each body's steps are drawn inside its container card, and
// how big that card is. Body positions are stored relative to the body's
// own corner, so moving the For each carries its body along.

type Position = Readonly<{ x: number; y: number }>;
type Size = Readonly<{ width: number; height: number }>;
type Rect = Position & Size;

/** A step card's usual size on the canvas, for placing steps near others. */
export const STEP_CARD = Object.freeze({ width: 224, height: 64 });

/** A For each container's layout around its body, in pixels. */
export const LOOP_FRAME = Object.freeze({
  /** The title row that carries the step's own ports. */
  header: 56,
  /** The "body ← item · ordinal … result →" row. */
  label: 24,
  /** The body area's margin from the card's sides. */
  inset: 8,
  /** Space around the steps inside the body area. */
  padding: 16,
  /** Bounds, body issues and Add step; an estimate for nested containers. */
  footer: 72,
  minWidth: 272,
  minHeight: 88,
});

/** Where a body's corner sits inside its container card. */
export const BODY_ORIGIN = Object.freeze({
  x: LOOP_FRAME.inset + LOOP_FRAME.padding,
  y: LOOP_FRAME.header + LOOP_FRAME.label + LOOP_FRAME.padding,
});

/** A plain card with a row of marks, so bodies leave room for them. */
const CARD_ESTIMATE: Size = Object.freeze({
  width: STEP_CARD.width,
  height: 80,
});
/** Columns and rows for body steps that were never placed apart. */
const AUTO_SLOT = Object.freeze({ x: STEP_CARD.width + 64, y: 104 });
const MAX_SLOT_ROWS = 1_000;

export type BodyFrame = Readonly<{
  /** The body area's size inside the container card. */
  width: number;
  height: number;
  /** Where each body step is drawn, relative to the body's corner. */
  positions: ReadonlyMap<string, Position>;
}>;

const noSteps: GraphLevel = Object.freeze({ nodes: [], edges: [] });
const sizes = new WeakMap<WorkflowNode, Size>();
const layouts = new WeakMap<GraphLevel, ReadonlyMap<string, Position>>();

/** How big a step is drawn: a card, or a container around its body. */
function cardSize(node: WorkflowNode): Size {
  const cached = sizes.get(node);
  if (cached !== undefined) return cached;
  let size = CARD_ESTIMATE;
  if (isForEach(node)) {
    const frame = bodyFrame(node.structured?.body);
    size = {
      width: frame.width + 2 * LOOP_FRAME.inset,
      height:
        LOOP_FRAME.header + LOOP_FRAME.label + frame.height + LOOP_FRAME.footer,
    };
  }
  sizes.set(node, size);
  return size;
}

/**
 * A body's area and where its steps are drawn. `moving` holds steps being
 * dragged right now (body coordinates), so the container grows with them.
 */
export function bodyFrame(
  body: GraphLevel | undefined,
  moving: ReadonlyMap<string, Position> = new Map(),
): BodyFrame {
  const level = body ?? noSteps;
  const positions = new Map(displayPositions(level));
  let right = 0;
  let bottom = 0;
  for (const node of level.nodes) {
    const at = moving.get(node.id) ?? positions.get(node.id) ?? node.position;
    positions.set(node.id, at);
    const size = cardSize(node);
    right = Math.max(right, at.x + size.width);
    bottom = Math.max(bottom, at.y + size.height);
  }
  return {
    width: Math.max(LOOP_FRAME.minWidth, right + 2 * LOOP_FRAME.padding),
    height: Math.max(LOOP_FRAME.minHeight, bottom + 2 * LOOP_FRAME.padding),
    positions,
  };
}

/**
 * Where a body's steps are shown. Stored positions are used as they are
 * (never above or left of the body's corner); a step stored exactly where
 * an earlier one is, as bodies built elsewhere often are, gets a free slot
 * in its execution column instead of hiding under it.
 */
export function displayPositions(
  level: GraphLevel,
): ReadonlyMap<string, Position> {
  const cached = layouts.get(level);
  if (cached !== undefined) return cached;
  const depths = stepDepths(level);
  const placed: (Rect & Readonly<{ stored: Position }>)[] = [];
  const positions = new Map<string, Position>();
  for (const node of level.nodes) {
    const size = cardSize(node);
    const stored = {
      x: Math.max(0, node.position.x),
      y: Math.max(0, node.position.y),
    };
    const repeated = placed.some(
      (rect) => rect.stored.x === stored.x && rect.stored.y === stored.y,
    );
    const at = repeated
      ? freeSlot(depths.get(node.id) ?? 0, size, placed)
      : stored;
    placed.push({ ...at, ...size, stored });
    positions.set(node.id, at);
  }
  layouts.set(level, positions);
  return positions;
}

function freeSlot(depth: number, size: Size, placed: readonly Rect[]) {
  const x = depth * AUTO_SLOT.x;
  let y = 0;
  for (let row = 0; row < MAX_SLOT_ROWS; row += 1) {
    const candidate = { x, y, ...size };
    if (!placed.some((rect) => overlaps(candidate, rect))) break;
    y += AUTO_SLOT.y;
  }
  return { x, y };
}

function overlaps(left: Rect, right: Rect): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

/**
 * Stores a body in the layout it's shown in. Commands settle a body before
 * changing it, so an edit never moves the steps people are looking at.
 */
export function settleBodyLayout<Level extends GraphLevel>(
  level: Level,
): Level {
  const positions = displayPositions(level);
  const nodes = level.nodes.map((node) => {
    const at = positions.get(node.id);
    if (
      at === undefined ||
      (at.x === node.position.x && at.y === node.position.y)
    )
      return node;
    return { ...node, position: { x: at.x, y: at.y } };
  });
  return nodes.some((node, index) => node !== level.nodes[index])
    ? { ...level, nodes }
    : level;
}

/**
 * A level as people see it: the workflow as stored, a body in the layout
 * it's drawn in. New steps are placed against this, so they land clear of
 * the steps on screen.
 */
export function shownLevel(
  graph: GraphLevel,
  scope: ScopePath,
): GraphLevel | undefined {
  const level = levelAt(graph, scope);
  return level === undefined || scope.length === 0
    ? level
    : settleBodyLayout(level);
}

/** A position on the canvas, relative to a container, in body coordinates. */
export function toBodyPosition(position: Position): Position {
  return {
    x: Math.max(0, Math.round(position.x - BODY_ORIGIN.x)),
    y: Math.max(0, Math.round(position.y - BODY_ORIGIN.y)),
  };
}

/**
 * Where steps were put on the canvas, as positions on their own levels: a
 * body step's canvas position is inside its container, stored relative to
 * the body's corner.
 */
export function levelPositions(
  graph: GraphLevel,
  positions: ReadonlyMap<string, Position>,
): ReadonlyMap<string, Position> {
  return new Map(
    [...positions].map(([nodeId, position]) => [
      nodeId,
      (scopeOf(graph, nodeId)?.length ?? 0) > 0
        ? toBodyPosition(position)
        : position,
    ]),
  );
}

/** A body position as the canvas draws it inside the container. */
export function fromBodyPosition(position: Position): Position {
  return { x: position.x + BODY_ORIGIN.x, y: position.y + BODY_ORIGIN.y };
}
