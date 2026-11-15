import {
  STORED_EXECUTION_VALUE_LIMITS,
  StoredExecutionValueInvalidError,
} from '@pertexo/node-sdk';
import {
  snapshotBoundedJson,
  UUID_PATTERN,
  utf8ByteLength,
} from '@pertexo/workflow-model';
import { types as nodeTypes } from 'node:util';
import type {
  StoredExecutionJsonValue,
  StoredExecutionValue,
} from '@pertexo/database/schema';

// PostgreSQL jsonb::text is only a storage backstop, not the application byte
// definition. Numeric exponents may expand by hundreds of bytes per member.
export const EXECUTION_JSONB_DATABASE_BACKSTOP_BYTES = 4_194_304;

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

// Stored inline values cost what the engine's guards charge them, and hold
// only text jsonb can store; the copy has no prototypes, so a stored key never
// meets an inherited member.
function cloneInlineJson(value: unknown): StoredExecutionJsonValue {
  const cloned = snapshotBoundedJson(
    value,
    {
      bytes: STORED_EXECUTION_VALUE_LIMITS.inlineBytes,
      depth: STORED_EXECUTION_VALUE_LIMITS.depth,
      members: STORED_EXECUTION_VALUE_LIMITS.members,
    },
    { jsonbText: true, nullPrototype: true, refuseObject: nodeTypes.isProxy },
  );
  if (!cloned.ok) invalid();
  return cloned.snapshot as StoredExecutionJsonValue;
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
