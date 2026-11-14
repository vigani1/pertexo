import { jsonStringByteLength } from '../text.js';

/** Bounds on a JSON value's text bytes, container nesting, members and array length. */
export type BoundedJsonSizeBounds = Readonly<{
  bytes: number;
  depth: number;
  members: number;
  /** Defaults to `members`: one array can't hold more items than the value has members. */
  arrayItems?: number;
}>;

/** Why a value isn't bounded JSON; each caller words its own refusal. */
export type BoundedJsonSizeRefusal =
  | 'bytes'
  | 'depth'
  | 'members'
  | 'array_items'
  | 'not_json'
  | 'cycle'
  | 'not_plain'
  | 'array_extra_keys'
  | 'sparse_array';

export type BoundedJsonSize =
  | Readonly<{ ok: true; bytes: number; depth: number; members: number }>
  | Readonly<{ ok: false; refusal: BoundedJsonSizeRefusal }>;

const UNBOUNDED: BoundedJsonSizeBounds = Object.freeze({
  bytes: Infinity,
  depth: Infinity,
  members: Infinity,
});

// JSON text widths: `null` and `true` are four bytes, `false` five, `-0` writes as `0`.
const NULL_BYTES = 4;
const TRUE_BYTES = 4;
const FALSE_BYTES = 5;
// A container's brackets, and the colon after an object key.
const BRACKET_BYTES = 2;
const COLON_BYTES = 1;
const COMMA_BYTES = 1;

type Frame =
  | Readonly<{ kind: 'value'; value: unknown; depth: number }>
  | Readonly<{ kind: 'exit'; value: object }>;

interface Walk {
  readonly bounds: BoundedJsonSizeBounds;
  readonly arrayItems: number;
  readonly pending: Frame[];
  readonly ancestors: Set<object>;
  bytes: number;
  depth: number;
  members: number;
}

/**
 * Measures a value as compact JSON text without building it, and refuses
 * anything that isn't plain, acyclic, dense JSON within its bounds. Every
 * bounded-JSON guard (checkpoints, executables, measured values) uses this
 * one walk, so they agree on what a value costs.
 */
export function measureBoundedJson(
  value: unknown,
  bounds: BoundedJsonSizeBounds = UNBOUNDED,
): BoundedJsonSize {
  const walk: Walk = {
    bounds,
    arrayItems: bounds.arrayItems ?? bounds.members,
    pending: [{ kind: 'value', value, depth: 1 }],
    ancestors: new Set<object>(),
    bytes: 0,
    depth: 0,
    members: 0,
  };
  while (walk.pending.length > 0) {
    const frame = walk.pending.pop();
    if (frame === undefined) continue;
    if (frame.kind === 'exit') {
      walk.ancestors.delete(frame.value);
      continue;
    }
    const refusal = measureValue(walk, frame.value, frame.depth);
    if (refusal !== undefined) return { ok: false, refusal };
  }
  return {
    ok: true,
    bytes: walk.bytes,
    depth: walk.depth,
    members: walk.members,
  };
}

function measureValue(
  walk: Walk,
  item: unknown,
  depth: number,
): BoundedJsonSizeRefusal | undefined {
  const primitive = primitiveBytes(item, walk.bounds.bytes - walk.bytes);
  if (primitive !== undefined) return addBytes(walk, primitive);
  if (typeof item !== 'object' || item === null) return 'not_json';
  if (depth > walk.bounds.depth) return 'depth';
  if (walk.ancestors.has(item)) return 'cycle';
  const isArray = Array.isArray(item);
  const prototype: unknown = Object.getPrototypeOf(item);
  if (!isArray && prototype !== Object.prototype && prototype !== null)
    return 'not_plain';
  if (isArray && item.length > walk.arrayItems) return 'array_items';
  walk.depth = Math.max(walk.depth, depth);
  const brackets = addBytes(
    walk,
    BRACKET_BYTES + (isArray ? Math.max(0, item.length - 1) * COMMA_BYTES : 0),
  );
  if (brackets !== undefined) return brackets;
  walk.ancestors.add(item);
  walk.pending.push({ kind: 'exit', value: item });
  return isArray
    ? enterArray(walk, item as readonly unknown[], depth)
    : enterObject(walk, item as Readonly<Record<string, unknown>>, depth);
}

function enterArray(
  walk: Walk,
  item: readonly unknown[],
  depth: number,
): BoundedJsonSizeRefusal | undefined {
  let count = 0;
  for (const key of Object.keys(item)) {
    walk.members += 1;
    if (walk.members > walk.bounds.members) return 'members';
    if (key !== String(count)) return 'array_extra_keys';
    count += 1;
    walk.pending.push({
      kind: 'value',
      value: item[Number(key)],
      depth: depth + 1,
    });
  }
  return count === item.length ? undefined : 'sparse_array';
}

function enterObject(
  walk: Walk,
  item: Readonly<Record<string, unknown>>,
  depth: number,
): BoundedJsonSizeRefusal | undefined {
  let count = 0;
  for (const key of Object.keys(item)) {
    walk.members += 1;
    if (walk.members > walk.bounds.members) return 'members';
    const separator = count > 0 ? COMMA_BYTES : 0;
    const keyBytes = jsonStringByteLength(key, {
      stopAfterBytes: walk.bounds.bytes - walk.bytes,
    });
    const refusal = addBytes(walk, separator + keyBytes + COLON_BYTES);
    if (refusal !== undefined) return refusal;
    count += 1;
    walk.pending.push({ kind: 'value', value: item[key], depth: depth + 1 });
  }
  return undefined;
}

function addBytes(walk: Walk, added: number): 'bytes' | undefined {
  walk.bytes += added;
  return walk.bytes > walk.bounds.bytes ? 'bytes' : undefined;
}

function primitiveBytes(
  item: unknown,
  remainingBytes: number,
): number | undefined {
  if (item === null) return NULL_BYTES;
  if (typeof item === 'string')
    return jsonStringByteLength(item, { stopAfterBytes: remainingBytes });
  if (typeof item === 'boolean') return item ? TRUE_BYTES : FALSE_BYTES;
  if (typeof item === 'number' && Number.isFinite(item))
    return Object.is(item, -0) ? 1 : String(item).length;
  return undefined;
}
