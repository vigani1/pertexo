type BoundedJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly BoundedJsonValue[]
  | BoundedJsonObject;

interface BoundedJsonObject {
  readonly [key: string]: BoundedJsonValue;
}

export const NODE_JSON_LIMITS_V1 = Object.freeze({
  bytes: 1_048_576,
  depth: 64,
  members: 10_000,
});

export type BoundedJsonLimits = Readonly<{
  bytes: number;
  depth: number;
  members: number;
}>;

type BoundedJsonFailureReason =
  | 'JSON byte limit exceeded'
  | 'JSON depth limit exceeded'
  | 'JSON member limit exceeded'
  | 'accessors are not JSON'
  | 'array properties are not JSON'
  | 'object must be plain'
  | 'repeated object reference'
  | 'sparse arrays are not JSON'
  | 'symbol properties are not JSON'
  | 'value could not be inspected safely'
  | 'value is not JSON';

export type BoundedJsonInspection =
  | Readonly<{ ok: true; value: BoundedJsonValue }>
  | Readonly<{ ok: false; reason: BoundedJsonFailureReason }>;

type MutableJsonObject = Record<string, BoundedJsonValue>;

interface JsonFrame {
  readonly source: object;
  readonly target: MutableJsonObject | BoundedJsonValue[];
  readonly keys: readonly string[];
  readonly depth: number;
  index: number;
}

type MutableJsonContainer = MutableJsonObject | BoundedJsonValue[];

type JsonContainerInspection =
  | Readonly<{
      ok: true;
      keys: readonly string[];
      target: MutableJsonContainer;
    }>
  | Readonly<{ ok: false; reason: BoundedJsonFailureReason }>;

function failure(reason: BoundedJsonFailureReason): BoundedJsonInspection {
  return { ok: false, reason };
}

function primitiveJson(value: unknown): BoundedJsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value))
    return Object.is(value, -0) ? 0 : value;
  return undefined;
}

function arrayLength(value: object): number | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  return descriptor !== undefined &&
    'value' in descriptor &&
    Number.isSafeInteger(descriptor.value) &&
    descriptor.value >= 0
    ? (descriptor.value as number)
    : undefined;
}

function objectKeys(
  value: object,
  isArray: boolean,
  length?: number,
): readonly string[] {
  return isArray
    ? Array.from({ length: length ?? 0 }, (_, index) => String(index))
    : Object.keys(value);
}

function inspectContainer(
  value: object,
  limits: BoundedJsonLimits,
): JsonContainerInspection {
  const isArray = Array.isArray(value);
  const length = isArray ? arrayLength(value) : undefined;
  if (isArray && length === undefined)
    return { ok: false, reason: 'array properties are not JSON' };
  if (length !== undefined && length > limits.members)
    return { ok: false, reason: 'JSON member limit exceeded' };
  if (!isArray) {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null)
      return { ok: false, reason: 'object must be plain' };
  }
  if (Object.getOwnPropertySymbols(value).length > 0)
    return { ok: false, reason: 'symbol properties are not JSON' };
  if (isArray && Object.keys(value).length !== length)
    return { ok: false, reason: 'array properties are not JSON' };

  return {
    ok: true,
    keys: objectKeys(value, isArray, length),
    target: isArray ? [] : {},
  };
}

function assignChild(
  target: MutableJsonContainer,
  key: string,
  child: BoundedJsonValue,
): void {
  if (Array.isArray(target)) {
    target[Number(key)] = child;
    return;
  }
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value: child,
    writable: true,
  });
}

function inspectObject(
  value: object,
  limits: BoundedJsonLimits,
): BoundedJsonInspection {
  const rootInspection = inspectContainer(value, limits);
  if (!rootInspection.ok) return failure(rootInspection.reason);
  const root = rootInspection.target;
  const seen = new Set<object>([value]);
  const stack: JsonFrame[] = [
    {
      source: value,
      target: root,
      keys: rootInspection.keys,
      depth: 1,
      index: 0,
    },
  ];
  let members = 0;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    if (frame.index >= frame.keys.length) {
      Object.freeze(frame.target);
      stack.pop();
      continue;
    }
    const key = frame.keys[frame.index];
    frame.index += 1;
    if (key === undefined) continue;
    members += 1;
    if (members > limits.members) return failure('JSON member limit exceeded');
    const descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
    if (descriptor === undefined || !('value' in descriptor))
      return failure('accessors are not JSON');
    if (Array.isArray(frame.source) && !Object.hasOwn(frame.source, key))
      return failure('sparse arrays are not JSON');

    const child: unknown = descriptor.value;
    const scalar = primitiveJson(child);
    if (scalar !== undefined) {
      assignChild(frame.target, key, scalar);
      continue;
    }
    if (typeof child !== 'object' || child === null)
      return failure('value is not JSON');
    const childDepth = frame.depth + 1;
    if (childDepth > limits.depth) return failure('JSON depth limit exceeded');
    if (seen.has(child)) return failure('repeated object reference');

    const childInspection = inspectContainer(child, limits);
    if (!childInspection.ok) return failure(childInspection.reason);
    const childTarget = childInspection.target;
    assignChild(frame.target, key, childTarget);
    seen.add(child);
    stack.push({
      source: child,
      target: childTarget,
      keys: childInspection.keys,
      depth: childDepth,
      index: 0,
    });
  }

  const snapshot = root as BoundedJsonValue;
  if (
    new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > limits.bytes
  )
    return failure('JSON byte limit exceeded');
  return { ok: true, value: snapshot };
}

function inspectBoundedJsonUnsafe(
  value: unknown,
  limits: BoundedJsonLimits,
): BoundedJsonInspection {
  const primitive = primitiveJson(value);
  if (primitive !== undefined) {
    if (
      new TextEncoder().encode(JSON.stringify(primitive)).byteLength >
      limits.bytes
    )
      return failure('JSON byte limit exceeded');
    return { ok: true, value: primitive };
  }
  if (typeof value !== 'object' || value === null)
    return failure('value is not JSON');
  return inspectObject(value, limits);
}

/**
 * Inspect untrusted JSON into one immutable own-data snapshot. Arbitrary
 * reflection failures are discarded without examining the thrown value.
 */
export function inspectBoundedJson(
  value: unknown,
  limits: BoundedJsonLimits = NODE_JSON_LIMITS_V1,
): BoundedJsonInspection {
  try {
    return inspectBoundedJsonUnsafe(value, limits);
  } catch {
    return failure('value could not be inspected safely');
  }
}
