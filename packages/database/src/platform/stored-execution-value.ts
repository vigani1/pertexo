import {
  STORED_EXECUTION_VALUE_LIMITS,
  StoredExecutionValueInvalidError,
  storedExecutionJsonStringBytes as jsonStringBytes,
} from '@pertexo/node-sdk';
import { UUID_PATTERN, utf8ByteLength } from '@pertexo/workflow-model';
import { types as nodeTypes } from 'node:util';
export {
  STORED_EXECUTION_VALUE_LIMITS,
  StoredExecutionValueInvalidError,
} from '@pertexo/node-sdk';

// PostgreSQL jsonb::text is only a storage backstop, not the application byte
// definition. Numeric exponents may expand by hundreds of bytes per member.
export const EXECUTION_JSONB_DATABASE_BACKSTOP_BYTES = 4_194_304;

export type StoredExecutionJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly StoredExecutionJsonValue[]
  | Readonly<{ [key: string]: StoredExecutionJsonValue }>;

export type StoredExecutionValue =
  | Readonly<{
      kind: 'inline';
      value: StoredExecutionJsonValue;
    }>
  | Readonly<{
      kind: 'artifact';
      artifactId: string;
    }>;

function invalid(): never {
  throw new StoredExecutionValueInvalidError();
}

function ownDataRecord(
  value: unknown,
  maximumFields: number,
): Map<string, unknown> {
  const invalidObject =
    value === null || typeof value !== 'object' || nodeTypes.isProxy(value);
  if (invalidObject) invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  const invalidPrototype =
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null);
  if (invalidPrototype) invalid();
  const fields = new Map<string, unknown>();
  for (const key in value) {
    if (!Object.hasOwn(value, key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const invalidDataProperty =
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor);
    if (invalidDataProperty) invalid();
    fields.set(key, descriptor.value);
    if (fields.size > maximumFields) invalid();
  }
  const ownNames = Object.getOwnPropertyNames(value);
  if (
    ownNames.length !== fields.size ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    invalid();
  return fields;
}

type CloneFrame =
  | Readonly<{
      kind: 'value';
      value: unknown;
      containerDepth: number;
      parent:
        StoredExecutionJsonValue[] | Record<string, StoredExecutionJsonValue>;
      key: string | number;
    }>
  | Readonly<{
      kind: 'exit';
      source: object;
      result:
        StoredExecutionJsonValue[] | Record<string, StoredExecutionJsonValue>;
    }>;

function assignValue(
  parent: StoredExecutionJsonValue[] | Record<string, StoredExecutionJsonValue>,
  key: string | number,
  value: StoredExecutionJsonValue,
): void {
  Object.defineProperty(parent, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function cloneInlineJson(value: unknown): StoredExecutionJsonValue {
  const root: Record<string, StoredExecutionJsonValue> = Object.create(
    null,
  ) as Record<string, StoredExecutionJsonValue>;
  const active = new Set<object>();
  const pending: CloneFrame[] = [
    { kind: 'value', value, containerDepth: 1, parent: root, key: 'value' },
  ];
  const budget = { members: 0 };
  let bytes = 0;
  const addBytes = (amount: number): void => {
    bytes += amount;
    if (bytes > STORED_EXECUTION_VALUE_LIMITS.inlineBytes) invalid();
  };

  while (pending.length !== 0) {
    const frame = pending.pop();
    if (frame === undefined) invalid();
    if (frame.kind === 'exit') {
      active.delete(frame.source);
      Object.freeze(frame.result);
      continue;
    }

    const item = frame.value;
    if (item === null) {
      addBytes(4);
      assignValue(frame.parent, frame.key, item);
      continue;
    }
    if (typeof item === 'boolean') {
      addBytes(item ? 4 : 5);
      assignValue(frame.parent, frame.key, item);
      continue;
    }
    if (typeof item === 'string') {
      addBytes(jsonStringBytes(item));
      assignValue(frame.parent, frame.key, item);
      continue;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid();
      const normalizedNumber = Object.is(item, -0) ? 0 : item;
      addBytes(String(normalizedNumber).length);
      assignValue(frame.parent, frame.key, normalizedNumber);
      continue;
    }
    if (typeof item !== 'object' || nodeTypes.isProxy(item)) invalid();
    if (frame.containerDepth > STORED_EXECUTION_VALUE_LIMITS.depth) invalid();
    if (active.has(item)) invalid();

    const { isArray, children } = readInlineChildren(item, {
      budget,
      addBytes,
    });
    const result:
      StoredExecutionJsonValue[] | Record<string, StoredExecutionJsonValue> =
      isArray
        ? []
        : (Object.create(null) as Record<string, StoredExecutionJsonValue>);
    assignValue(frame.parent, frame.key, result);
    active.add(item);
    pending.push({ kind: 'exit', source: item, result });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child === undefined) invalid();
      pending.push({
        kind: 'value',
        value: child.value,
        containerDepth: frame.containerDepth + 1,
        parent: result,
        key: child.key,
      });
    }
  }

  const normalized = root.value;
  if (normalized === undefined) invalid();
  return normalized;
}

function readInlineChildren(
  item: object,
  {
    budget,
    addBytes,
  }: Readonly<{
    budget: { members: number };
    addBytes: (amount: number) => void;
  }>,
) {
  const isArray = Array.isArray(item);
  const prototype = Object.getPrototypeOf(item) as unknown;
  const invalidPrototype =
    !isArray && prototype !== Object.prototype && prototype !== null;
  if (invalidPrototype) invalid();
  if (isArray && item.length > STORED_EXECUTION_VALUE_LIMITS.members) invalid();
  const children: { key: string | number; value: unknown }[] = [];
  let enumerableCount = 0;
  for (const key in item) {
    if (!Object.hasOwn(item, key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(item, key);
    const invalidDescriptor =
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor);
    if (invalidDescriptor) invalid();
    budget.members += 1;
    if (budget.members > STORED_EXECUTION_VALUE_LIMITS.members) invalid();
    if (isArray && key !== String(enumerableCount)) invalid();
    if (!isArray) addBytes(jsonStringBytes(key) + 1);
    children.push({
      key: isArray ? enumerableCount : key,
      value: descriptor.value,
    });
    enumerableCount += 1;
  }
  const ownNames = Object.getOwnPropertyNames(item);
  assertInlineOwnProperties(item, { enumerableCount, ownNames });
  addBytes(2 + Math.max(0, enumerableCount - 1));

  return { isArray, children };
}

function assertInlineOwnProperties(
  item: object,
  {
    enumerableCount,
    ownNames,
  }: Readonly<{ enumerableCount: number; ownNames: readonly string[] }>,
): void {
  const isArray = Array.isArray(item);
  const invalidOwnProperties =
    Object.getOwnPropertySymbols(item).length !== 0 ||
    (isArray &&
      (enumerableCount !== item.length ||
        ownNames.length !== item.length + 1 ||
        !ownNames.includes('length'))) ||
    (!isArray && ownNames.length !== enumerableCount);
  if (invalidOwnProperties) invalid();
}

/**
 * Stored values keep the key order they were written with, as people see
 * them. Comparisons and checksums use the sorted, canonical text instead.
 */
function serializeJson(
  value: StoredExecutionJsonValue,
  order: 'as_written' | 'canonical',
): string {
  type Frame =
    | Readonly<{ kind: 'value'; value: StoredExecutionJsonValue }>
    | Readonly<{ kind: 'token'; token: string }>;
  const frames: Frame[] = [{ kind: 'value', value }];
  const chunks: string[] = [];
  while (frames.length !== 0) {
    const frame = frames.pop();
    if (frame === undefined) invalid();
    if (frame.kind === 'token') {
      chunks.push(frame.token);
      continue;
    }
    const item = frame.value;
    if (item === null || typeof item !== 'object') {
      chunks.push(JSON.stringify(item));
      continue;
    }
    if (Array.isArray(item)) {
      const array = item as readonly StoredExecutionJsonValue[];
      frames.push({ kind: 'token', token: ']' });
      for (let index = array.length - 1; index >= 0; index -= 1) {
        const child = array[index];
        if (child === undefined) invalid();
        frames.push({ kind: 'value', value: child });
        if (index !== 0) frames.push({ kind: 'token', token: ',' });
      }
      frames.push({ kind: 'token', token: '[' });
      continue;
    }
    const record = item as Readonly<Record<string, StoredExecutionJsonValue>>;
    const keys =
      order === 'canonical' ? Object.keys(record).sort() : Object.keys(record);
    frames.push({ kind: 'token', token: '}' });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) invalid();
      const child = record[key];
      if (child === undefined) invalid();
      frames.push({ kind: 'value', value: child });
      frames.push({ kind: 'token', token: ':' });
      frames.push({ kind: 'token', token: JSON.stringify(key) });
      if (index !== 0) frames.push({ kind: 'token', token: ',' });
    }
    frames.push({ kind: 'token', token: '{' });
  }
  return chunks.join('');
}

export function parseStoredExecutionValue(
  value: unknown,
): StoredExecutionValue {
  let input = value;
  if (typeof input === 'string') {
    if (utf8ByteLength(input) > EXECUTION_JSONB_DATABASE_BACKSTOP_BYTES)
      invalid();
    try {
      input = JSON.parse(input);
    } catch {
      invalid();
    }
  }
  const fields = ownDataRecord(input, 2);
  const kind = fields.get('kind');

  if (kind === 'artifact') {
    if (fields.size !== 2) invalid();
    const artifactId = fields.get('artifactId');
    if (typeof artifactId !== 'string' || !UUID_PATTERN.test(artifactId))
      invalid();
    return Object.freeze({ kind, artifactId });
  }
  if (kind === 'inline') {
    if (fields.size !== 2 || !fields.has('value')) invalid();
    return Object.freeze({
      kind,
      value: cloneInlineJson(fields.get('value')),
    });
  }
  invalid();
}

function storedValueJson(
  parsed: StoredExecutionValue,
  order: 'as_written' | 'canonical',
): string {
  return parsed.kind === 'artifact'
    ? `{"artifactId":${JSON.stringify(parsed.artifactId)},"kind":"artifact"}`
    : `{"kind":"inline","value":${serializeJson(parsed.value, order)}}`;
}

export function prepareStoredExecutionValue(value: unknown): Readonly<{
  value: StoredExecutionValue;
  json: string;
}> {
  const parsed = parseStoredExecutionValue(value);
  return { value: parsed, json: storedValueJson(parsed, 'as_written') };
}

export function serializeStoredExecutionValue(value: unknown): string {
  return prepareStoredExecutionValue(value).json;
}

export function serializeStoredExecutionJsonValue(value: unknown): string {
  const parsed = parseStoredExecutionValue({
    kind: 'inline',
    value,
  });
  if (parsed.kind !== 'inline') invalid();
  return serializeJson(parsed.value, 'canonical');
}

/** A JSON value's text with its keys in the order they were written. */
export function serializeWrittenJsonValue(value: unknown): string {
  const parsed = parseStoredExecutionValue({
    kind: 'inline',
    value,
  });
  if (parsed.kind !== 'inline') invalid();
  return serializeJson(parsed.value, 'as_written');
}

/** Descriptor fields do not consume the inline value's byte/member budget. */
export function storedExecutionValuesEqual(
  left: unknown,
  right: unknown,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    storedValueJson(parseStoredExecutionValue(left), 'canonical') ===
    storedValueJson(parseStoredExecutionValue(right), 'canonical')
  );
}
