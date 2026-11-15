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

/** The measure's refusals, plus those of the snapshot's strict reading and options. */
export type BoundedJsonSnapshotRefusal =
  | BoundedJsonSizeRefusal
  | 'accessor'
  | 'hidden_property'
  | 'symbol_key'
  | 'unstorable_text';

/** JSON text widths of the literals: `null` and `true` are four bytes, `false` five. */
export const JSON_LITERAL_BYTES = Object.freeze({ null: 4, true: 4, false: 5 });
const NULL_BYTES = JSON_LITERAL_BYTES.null;
const TRUE_BYTES = JSON_LITERAL_BYTES.true;
const FALSE_BYTES = JSON_LITERAL_BYTES.false;
// A container's brackets, and the colon after an object key.
const BRACKET_BYTES = 2;
const COLON_BYTES = 1;
const COMMA_BYTES = 1;
const UNICODE_NULL = '\u0000';

/**
 * How a container's members are read: `get` like `JSON.stringify` (own
 * enumerable keys, getters run); `exact` and `written` only through data
 * descriptors, refusing accessors and symbol keys. `exact` also refuses what
 * JSON would leave out (hidden properties, an array's named ones); `written`
 * skips those as `JSON.stringify` does.
 */
export type MemberReading = 'get' | 'exact' | 'written';

export interface Rules {
  readonly reading: MemberReading;
  readonly depthCountsValues: boolean;
  readonly allowNonFiniteNumbers: boolean;
  readonly jsonbText: boolean;
  readonly nullPrototype: boolean;
  readonly refuseObject: ((value: object) => boolean) | undefined;
  /** Present when the walk builds a snapshot. */
  readonly root: { value: unknown } | undefined;
}

export const MEASURE_RULES: Rules = Object.freeze({
  reading: 'get',
  depthCountsValues: false,
  allowNonFiniteNumbers: false,
  jsonbText: false,
  nullPrototype: false,
  refuseObject: undefined,
  root: undefined,
});

type Container = Record<string, unknown> | unknown[];

// A path link per value, only while snapshotting; joined only on a refusal.
export type Place = Readonly<{
  parent: Place | undefined;
  key: string | number;
}>;

type Frame =
  | Readonly<{
      kind: 'value';
      value: unknown;
      depth: number;
      place: Place | undefined;
      target: Container | undefined;
    }>
  | Readonly<{ kind: 'exit'; value: object; copy: Container | undefined }>;

interface Walk {
  readonly bounds: BoundedJsonSizeBounds;
  readonly rules: Rules;
  readonly arrayItems: number;
  readonly pending: Frame[];
  readonly ancestors: Set<object>;
  bytes: number;
  depth: number;
  members: number;
}

export type Walked =
  | Readonly<{ ok: true; bytes: number; depth: number; members: number }>
  | Readonly<{
      ok: false;
      refusal: BoundedJsonSnapshotRefusal;
      at: Place | undefined;
    }>;

type Refused = Readonly<{
  refusal: BoundedJsonSnapshotRefusal;
  at: Place | undefined;
}>;

export function walkBoundedJson(
  value: unknown,
  bounds: BoundedJsonSizeBounds,
  rules: Rules,
): Walked {
  const walk: Walk = {
    bounds,
    rules,
    arrayItems: bounds.arrayItems ?? bounds.members,
    pending: [
      { kind: 'value', value, depth: 1, place: undefined, target: undefined },
    ],
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
      if (frame.copy !== undefined) Object.freeze(frame.copy);
      continue;
    }
    const refused = visitValue(walk, frame);
    if (refused !== undefined) return { ok: false, ...refused };
  }
  return {
    ok: true,
    bytes: walk.bytes,
    depth: walk.depth,
    members: walk.members,
  };
}

function visitValue(walk: Walk, frame: ValueFrame): Refused | undefined {
  const { value: item, depth, place } = frame;
  const refuse = (refusal: BoundedJsonSnapshotRefusal): Refused => ({
    refusal,
    at: place,
  });
  if (walk.rules.depthCountsValues && depth > walk.bounds.depth)
    return refuse('depth');
  const primitive = primitiveCost(walk, item);
  if (typeof primitive === 'string') return refuse(primitive);
  if (primitive !== undefined) {
    if (addBytes(walk, primitive) !== undefined) return refuse('bytes');
    keep(walk, frame, Object.is(item, -0) ? 0 : item);
    return undefined;
  }
  if (typeof item !== 'object' || item === null) return refuse('not_json');
  if (depth > walk.bounds.depth) return refuse('depth');
  if (walk.ancestors.has(item)) return refuse('cycle');
  // The host's refusal comes first: reading a revoked proxy's prototype throws.
  if (walk.rules.refuseObject?.(item) === true) return refuse('not_plain');
  const isArray = Array.isArray(item);
  const prototype: unknown = Object.getPrototypeOf(item);
  const plain = isArray || prototype === Object.prototype || prototype === null;
  if (!plain) return refuse('not_plain');
  walk.depth = Math.max(walk.depth, depth);
  const entered = isArray
    ? enterArray(walk, frame, item as readonly unknown[])
    : enterObject(walk, frame, item);
  if ('refusal' in entered) return entered;
  const copy = keep(walk, frame, newContainer(walk, isArray));
  walk.ancestors.add(item);
  walk.pending.push({ kind: 'exit', value: item, copy });
  pushChildren(walk, frame, entered, copy);
  return undefined;
}

type ValueFrame = Extract<Frame, { kind: 'value' }>;
type Members = readonly (readonly [key: string, value: unknown])[];

/** Costs an array's brackets and commas before reading any item. */
function enterArray(
  walk: Walk,
  frame: ValueFrame,
  item: readonly unknown[],
): Members | Refused {
  const refuse = (refusal: BoundedJsonSnapshotRefusal): Refused => ({
    refusal,
    at: frame.place,
  });
  const length = arrayLength(walk, item);
  if (length === undefined) return refuse('not_json');
  if (length > walk.arrayItems) return refuse('array_items');
  const brackets = BRACKET_BYTES + Math.max(0, length - 1) * COMMA_BYTES;
  if (addBytes(walk, brackets) !== undefined) return refuse('bytes');
  const members = readMembers(walk, frame, item, length);
  if ('refusal' in members) return members;
  for (const [index, [key]] of members.entries()) {
    walk.members += 1;
    if (walk.members > walk.bounds.members) return refuse('members');
    if (key !== String(index)) return refuse('array_extra_keys');
  }
  return members.length === length ? members : refuse('sparse_array');
}

function enterObject(
  walk: Walk,
  frame: ValueFrame,
  item: object,
): Members | Refused {
  const refuse = (refusal: BoundedJsonSnapshotRefusal): Refused => ({
    refusal,
    at: frame.place,
  });
  if (addBytes(walk, BRACKET_BYTES) !== undefined) return refuse('bytes');
  const members = readMembers(walk, frame, item, undefined);
  if ('refusal' in members) return members;
  for (const [index, [key]] of members.entries()) {
    walk.members += 1;
    if (walk.members > walk.bounds.members) return refuse('members');
    if (walk.rules.jsonbText && !isJsonbText(key))
      return { refusal: 'unstorable_text', at: placeIn(walk, frame, key) };
    const separator = index > 0 ? COMMA_BYTES : 0;
    const keyBytes = jsonStringByteLength(key, {
      stopAfterBytes: walk.bounds.bytes - walk.bytes,
    });
    if (addBytes(walk, separator + keyBytes + COLON_BYTES) !== undefined)
      return refuse('bytes');
  }
  return members;
}

// A descriptor read keeps a proxy's length trap from answering twice.
function arrayLength(walk: Walk, item: readonly unknown[]): number | undefined {
  if (walk.rules.reading === 'get') return item.length;
  const descriptor = Object.getOwnPropertyDescriptor(item, 'length');
  const length: unknown =
    descriptor !== undefined && 'value' in descriptor
      ? descriptor.value
      : undefined;
  return typeof length === 'number' &&
    Number.isSafeInteger(length) &&
    length >= 0
    ? length
    : undefined;
}

/** An array's length is given; an object's is undefined. */
function readMembers(
  walk: Walk,
  frame: ValueFrame,
  item: object,
  length: number | undefined,
): Members | Refused {
  const record = item as Readonly<Record<string, unknown>>;
  const { reading } = walk.rules;
  if (reading === 'get')
    return Object.keys(item).map((key) => [key, record[key]] as const);
  if (Object.getOwnPropertySymbols(item).length > 0)
    return { refusal: 'symbol_key', at: frame.place };
  const keys =
    reading === 'written' && length !== undefined
      ? Array.from({ length }, (_, index) => String(index))
      : Object.keys(item);
  // Every own name but an array's `length` must be one JSON writes.
  const written = keys.length + (length === undefined ? 0 : 1);
  if (
    reading === 'exact' &&
    Object.getOwnPropertyNames(item).length !== written
  )
    return { refusal: 'hidden_property', at: frame.place };
  const members: (readonly [string, unknown])[] = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(item, key);
    const at = placeIn(walk, frame, length === undefined ? key : arrayKey(key));
    if (descriptor === undefined) return { refusal: 'sparse_array', at };
    if (!('value' in descriptor)) return { refusal: 'accessor', at };
    members.push([key, descriptor.value]);
  }
  return members;
}

// An array's index keys are reported as numbers, so a path tells them from names.
function arrayKey(key: string): string | number {
  const index = Number(key);
  return String(index) === key ? index : key;
}

// Pushed last-first so the walk visits members in document order.
function pushChildren(
  walk: Walk,
  frame: ValueFrame,
  members: Members,
  copy: Container | undefined,
): void {
  const isArray = Array.isArray(frame.value);
  for (let index = members.length - 1; index >= 0; index -= 1) {
    const member = members[index];
    if (member === undefined) continue;
    const [key, value] = member;
    walk.pending.push({
      kind: 'value',
      value,
      depth: frame.depth + 1,
      place: placeIn(walk, frame, isArray ? index : key),
      target: copy,
    });
  }
}

function placeIn(
  walk: Walk,
  frame: ValueFrame,
  key: string | number,
): Place | undefined {
  return walk.rules.root === undefined
    ? undefined
    : { parent: frame.place, key };
}

function addBytes(walk: Walk, added: number): 'bytes' | undefined {
  walk.bytes += added;
  return walk.bytes > walk.bounds.bytes ? 'bytes' : undefined;
}

/** A primitive's JSON text bytes, its refusal, or undefined for anything else. */
function primitiveCost(
  walk: Walk,
  item: unknown,
): number | BoundedJsonSnapshotRefusal | undefined {
  if (item === null) return NULL_BYTES;
  if (typeof item === 'string') {
    if (walk.rules.jsonbText && !isJsonbText(item)) return 'unstorable_text';
    return jsonStringByteLength(item, {
      stopAfterBytes: walk.bounds.bytes - walk.bytes,
    });
  }
  if (typeof item === 'boolean') return item ? TRUE_BYTES : FALSE_BYTES;
  if (typeof item === 'number') {
    if (Number.isFinite(item))
      return Object.is(item, -0) ? 1 : String(item).length;
    return walk.rules.allowNonFiniteNumbers ? NULL_BYTES : 'not_json';
  }
  return undefined;
}

function isJsonbText(text: string): boolean {
  return text.isWellFormed() && !text.includes(UNICODE_NULL);
}

function newContainer(walk: Walk, isArray: boolean): Container {
  if (isArray) return [];
  return walk.rules.nullPrototype
    ? (Object.create(null) as Record<string, unknown>)
    : {};
}

/** Places a snapshot value under its parent copy; returns it when it is a container. */
function keep<T>(
  walk: Walk,
  frame: ValueFrame,
  value: T,
): (T & Container) | undefined {
  const root = walk.rules.root;
  if (root === undefined) return undefined;
  const target = frame.target;
  if (target === undefined) root.value = value;
  else
    Object.defineProperty(target, frame.place?.key ?? '', {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  return typeof value === 'object' && value !== null
    ? (value as T & Container)
    : undefined;
}
