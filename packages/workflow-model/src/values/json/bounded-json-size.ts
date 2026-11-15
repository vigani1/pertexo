import {
  MEASURE_RULES,
  walkBoundedJson,
  type MemberReading,
  type Place,
  type BoundedJsonSizeBounds,
  type BoundedJsonSizeRefusal,
  type BoundedJsonSnapshotRefusal,
} from './bounded-json-walk.js';

export type BoundedJsonSize =
  | Readonly<{ ok: true; bytes: number; depth: number; members: number }>
  | Readonly<{ ok: false; refusal: BoundedJsonSizeRefusal }>;

/** Where a refused value sits: object keys and array indexes from the root. */
export type BoundedJsonPath = readonly (string | number)[];

export type BoundedJsonSnapshot =
  | Readonly<{
      ok: true;
      snapshot: unknown;
      bytes: number;
      depth: number;
      members: number;
    }>
  | Readonly<{
      ok: false;
      refusal: BoundedJsonSnapshotRefusal;
      path: BoundedJsonPath;
    }>;

export type BoundedJsonSnapshotOptions = Readonly<{
  /**
   * `exact` (the default) refuses own properties JSON would leave out (hidden
   * ones, an array's named ones); `written` skips them as `JSON.stringify`
   * does. Both refuse accessors and symbol keys.
   */
  properties?: Exclude<MemberReading, 'get'>;
  /**
   * `containers` (the default) bounds the nesting of objects and arrays;
   * `values` bounds every value's depth, leaves included, as the graph's
   * depth limits count it.
   */
  depthCounts?: 'containers' | 'values';
  /** NaN and the infinities, written by JSON as `null`; refused otherwise. */
  allowNonFiniteNumbers?: boolean;
  /** Refuses text PostgreSQL `jsonb` can't hold: U+0000 and lone surrogates. */
  jsonbText?: boolean;
  /** Copies objects without a prototype, so no inherited member can shadow a key. */
  nullPrototype?: boolean;
  /** An extra refusal for objects the host can recognise, such as proxies. */
  refuseObject?: (value: object) => boolean;
}>;
const UNBOUNDED: BoundedJsonSizeBounds = Object.freeze({
  bytes: Infinity,
  depth: Infinity,
  members: Infinity,
});

/**
 * Measures a value as compact JSON text without building it, and refuses
 * anything that isn't plain, acyclic, dense JSON within its bounds. Guards on
 * untrusted values (checkpoints, executables) use this walk, which stops at the
 * first bound crossed; an already-normalized value is measured natively by
 * `inspectJsonValue`, and json-measures.test.ts keeps the two in agreement.
 * It reads members the way `JSON.stringify` does: own enumerable string keys.
 */
export function measureBoundedJson(
  value: unknown,
  bounds: BoundedJsonSizeBounds = UNBOUNDED,
): BoundedJsonSize {
  const walked = walkBoundedJson(value, bounds, MEASURE_RULES);
  return walked.ok
    ? {
        ok: true,
        bytes: walked.bytes,
        depth: walked.depth,
        members: walked.members,
      }
    : // Measure rules read leniently and keep all text, so the walk can only
      // refuse with a measure refusal here.
      { ok: false, refusal: walked.refusal as BoundedJsonSizeRefusal };
}

/**
 * The same walk and costs as `measureBoundedJson`, building a frozen copy as
 * it goes, for input that is then trusted (graph admission, stored values).
 * It reads only own, enumerable data properties, so no getter runs and nothing
 * hidden is dropped silently, and it writes `-0` as `0`, as JSON does.
 */
export function snapshotBoundedJson(
  value: unknown,
  bounds: BoundedJsonSizeBounds = UNBOUNDED,
  options: BoundedJsonSnapshotOptions = {},
): BoundedJsonSnapshot {
  const root = { value: undefined as unknown };
  const walked = walkBoundedJson(value, bounds, {
    reading: options.properties ?? 'exact',
    depthCountsValues: options.depthCounts === 'values',
    allowNonFiniteNumbers: options.allowNonFiniteNumbers ?? false,
    jsonbText: options.jsonbText ?? false,
    nullPrototype: options.nullPrototype ?? false,
    refuseObject: options.refuseObject,
    root,
  });
  return walked.ok
    ? {
        ok: true,
        snapshot: root.value,
        bytes: walked.bytes,
        depth: walked.depth,
        members: walked.members,
      }
    : { ok: false, refusal: walked.refusal, path: pathOf(walked.at) };
}

function pathOf(place: Place | undefined): BoundedJsonPath {
  const path: (string | number)[] = [];
  for (let at = place; at !== undefined; at = at.parent) path.push(at.key);
  return path.reverse();
}
