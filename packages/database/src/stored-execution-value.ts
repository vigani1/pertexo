import { types as nodeTypes } from 'node:util';

export const STORED_EXECUTION_VALUE_LIMITS_V1 = Object.freeze({
  inlineBytes: 262_144,
  depth: 64,
  members: 10_000,
});

// PostgreSQL jsonb::text is only a storage backstop, not the application byte
// definition. Numeric exponents may expand by hundreds of bytes per member.
export const EXECUTION_JSONB_DATABASE_BACKSTOP_BYTES_V1 = 4_194_304;

export type StoredExecutionJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly StoredExecutionJsonValue[]
  | Readonly<{ [key: string]: StoredExecutionJsonValue }>;

export type StoredExecutionValueV1 =
  | Readonly<{
      schemaVersion: 1;
      kind: 'inline';
      value: StoredExecutionJsonValue;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: 'artifact';
      artifactId: string;
    }>;

export class StoredExecutionValueInvalidError extends TypeError {
  public override readonly name = 'StoredExecutionValueInvalidError';

  public constructor() {
    super('Stored execution value violates the V1 persistence contract');
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function invalid(): never {
  throw new StoredExecutionValueInvalidError();
}

function jsonStringBytes(value: string): number {
  let bytes = 2;
  const add = (amount: number): void => {
    bytes += amount;
    if (bytes > STORED_EXECUTION_VALUE_LIMITS_V1.inlineBytes) invalid();
  };
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || (code >= 0xdc00 && code <= 0xdfff)) invalid();
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x0c ||
      code === 0x0a ||
      code === 0x0d ||
      code === 0x09
    )
      add(2);
    else if (code <= 0x1f) add(6);
    else if (code <= 0x7f) add(1);
    else if (code <= 0x7ff) add(2);
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
      add(4);
      index += 1;
    } else add(3);
  }
  return bytes;
}

function ownDataRecord(
  value: unknown,
  maximumFields: number,
): Map<string, unknown> {
  if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value))
    invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  )
    invalid();
  const fields = new Map<string, unknown>();
  for (const key in value) {
    if (!Object.hasOwn(value, key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    )
      invalid();
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
  let members = 0;
  let bytes = 0;
  const addBytes = (amount: number): void => {
    bytes += amount;
    if (bytes > STORED_EXECUTION_VALUE_LIMITS_V1.inlineBytes) invalid();
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
    if (frame.containerDepth > STORED_EXECUTION_VALUE_LIMITS_V1.depth)
      invalid();
    if (active.has(item)) invalid();

    const isArray = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item) as unknown;
    if (!isArray && prototype !== Object.prototype && prototype !== null)
      invalid();
    if (isArray && item.length > STORED_EXECUTION_VALUE_LIMITS_V1.members)
      invalid();
    const children: { key: string | number; value: unknown }[] = [];
    let enumerableCount = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      )
        invalid();
      members += 1;
      if (members > STORED_EXECUTION_VALUE_LIMITS_V1.members) invalid();
      if (isArray && key !== String(enumerableCount)) invalid();
      if (!isArray) addBytes(jsonStringBytes(key) + 1);
      children.push({
        key: isArray ? enumerableCount : key,
        value: descriptor.value,
      });
      enumerableCount += 1;
    }
    const ownNames = Object.getOwnPropertyNames(item);
    if (
      Object.getOwnPropertySymbols(item).length !== 0 ||
      (isArray &&
        (enumerableCount !== item.length ||
          ownNames.length !== item.length + 1 ||
          !ownNames.includes('length'))) ||
      (!isArray && ownNames.length !== enumerableCount)
    )
      invalid();
    addBytes(2 + Math.max(0, enumerableCount - 1));
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

function canonicalJson(value: StoredExecutionJsonValue): string {
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
    const keys = Object.keys(record).sort();
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

export function parseStoredExecutionValueV1(
  value: unknown,
): StoredExecutionValueV1 {
  let input = value;
  if (typeof input === 'string') {
    if (
      Buffer.byteLength(input, 'utf8') >
      EXECUTION_JSONB_DATABASE_BACKSTOP_BYTES_V1
    )
      invalid();
    try {
      input = JSON.parse(input) as unknown;
    } catch {
      invalid();
    }
  }
  const fields = ownDataRecord(input, 3);
  const schemaVersion = fields.get('schemaVersion');
  const kind = fields.get('kind');
  if (schemaVersion !== 1) invalid();

  if (kind === 'artifact') {
    if (fields.size !== 3) invalid();
    const artifactId = fields.get('artifactId');
    if (typeof artifactId !== 'string' || !uuidPattern.test(artifactId))
      invalid();
    return Object.freeze({ schemaVersion: 1, kind, artifactId });
  }
  if (kind === 'inline') {
    if (fields.size !== 3 || !fields.has('value')) invalid();
    return Object.freeze({
      schemaVersion: 1,
      kind,
      value: cloneInlineJson(fields.get('value')),
    });
  }
  invalid();
}

export function serializeStoredExecutionValueV1(value: unknown): string {
  const parsed = parseStoredExecutionValueV1(value);
  return parsed.kind === 'artifact'
    ? `{"artifactId":${JSON.stringify(parsed.artifactId)},"kind":"artifact","schemaVersion":1}`
    : `{"kind":"inline","schemaVersion":1,"value":${canonicalJson(parsed.value)}}`;
}
