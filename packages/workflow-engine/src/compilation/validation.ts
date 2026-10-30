import { jsonStringByteLength } from '@pertexo/workflow-model';
import { types as nodeTypes } from 'node:util';
import type {
  DefinitionIdentity,
  NodeManifest,
  PolicyReference,
} from '@pertexo/node-sdk';
import {
  canonicalJson,
  isRecord,
  normalizedJson,
  type JsonValue,
} from '@pertexo/workflow-model';
import { hasExactFields } from '../exact-fields.js';
import type { SideEffectClass } from '../types.js';
import {
  type ExecutableRuntimePolicies,
  WORKFLOW_EXECUTABLE_LIMITS,
  compareIdentity,
  fail,
  token,
} from './foundation.js';

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

export function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (!hasExactFields(value, required, optional))
    fail('executable envelope contains missing or unknown fields');
}

function assertSafeExecutableJson(value: unknown): void {
  type Frame =
    | {
        readonly kind: 'value';
        readonly value: unknown;
        readonly depth: number;
      }
    | { readonly kind: 'exit'; readonly value: object };
  const pending: Frame[] = [{ kind: 'value', value, depth: 1 }];
  const ancestors = new Set<object>();
  let members = 0;
  let bytes = 0;
  const add = (amount: number): void => {
    bytes += amount;
    if (bytes > WORKFLOW_EXECUTABLE_LIMITS.bytes)
      fail('executable envelope exceeds maximum bytes');
  };
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    if (frame.kind === 'exit') {
      ancestors.delete(frame.value);
      continue;
    }
    const item = frame.value;
    if (item === null) {
      add(4);
      continue;
    }
    const primitiveBytes = executablePrimitiveBytes(
      item,
      WORKFLOW_EXECUTABLE_LIMITS.bytes - bytes,
    );
    if (primitiveBytes !== undefined) {
      add(primitiveBytes);
      continue;
    }
    if (typeof item !== 'object') fail('executable envelope must contain JSON');
    assertExecutableContainer(item, frame.depth, ancestors);
    const isArray = Array.isArray(item);
    const prototype: object | null = Object.getPrototypeOf(item) as
      object | null;
    const plainContainer =
      isArray || prototype === Object.prototype || prototype === null;
    if (!plainContainer) fail('executable envelope must contain plain objects');
    if (isArray && item.length > WORKFLOW_EXECUTABLE_LIMITS.members)
      fail('executable envelope array is oversized');
    add(2 + (isArray ? Math.max(0, item.length - 1) : 0));
    ancestors.add(item);
    pending.push({ kind: 'exit', value: item });
    let enumerableCount = 0;
    for (const key in item) {
      const descriptor = executableDataField(item, key);
      members += 1;
      if (members > WORKFLOW_EXECUTABLE_LIMITS.members)
        fail('executable envelope exceeds maximum members');
      if (isArray && key !== String(enumerableCount))
        fail('executable envelope array is sparse or has extra fields');
      if (!isArray) {
        if (enumerableCount > 0) add(1);
        add(
          jsonStringByteLength(key, {
            stopAfterBytes: WORKFLOW_EXECUTABLE_LIMITS.bytes - bytes,
          }),
        );
        add(1);
      }
      enumerableCount += 1;
      pending.push({
        kind: 'value',
        value: descriptor.value,
        depth: frame.depth + 1,
      });
    }
    assertExecutableOwnFields(item, {
      arrayLength: isArray ? item.length : undefined,
      enumerableCount,
    });
  }
}

/** Engine structures, with sorted keys so they compare by their text. */
export function normalizeBoundedEngineJson(value: unknown): JsonValue {
  assertSafeExecutableJson(value);
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

/** Data a step reads or returns, keeping the key order it was written in. */
export function normalizeBoundedEngineValue(value: unknown): JsonValue {
  assertSafeExecutableJson(value);
  return JSON.parse(normalizedJson(value)) as JsonValue;
}

export function parseIdentity(
  value: unknown,
  label: string,
): DefinitionIdentity {
  const identity = record(value, label);
  const { version } = identity;

  exactKeys(identity, ['key', 'version']);
  if (
    typeof identity.key !== 'string' ||
    !/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u.test(identity.key)
  )
    fail(`${label} is invalid`);
  const invalidVersion =
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1;
  if (invalidVersion) fail(`${label} is invalid`);
  return { key: identity.key, version: version };
}

export function parseGlobals(value: unknown): ExecutableRuntimePolicies {
  const policies = record(value, 'runtime policies');
  exactKeys(policies, [
    'scheduler',
    'checkpoint',
    'retry',
    'timeout',
    'cancellation',
  ]);
  return {
    scheduler: parseIdentity(policies.scheduler, 'scheduler policy'),
    checkpoint: parseIdentity(policies.checkpoint, 'checkpoint policy'),
    retry: parseIdentity(policies.retry, 'retry policy'),
    timeout: parseIdentity(policies.timeout, 'timeout policy'),
    cancellation: parseIdentity(policies.cancellation, 'cancellation policy'),
  };
}

export function parsePolicies(value: unknown): readonly PolicyReference[] {
  if (!Array.isArray(value)) fail('node policies must be an array');
  const policies = value.map((item) => parseIdentity(item, 'node policy'));
  if (new Set(policies.map(token)).size !== policies.length)
    fail('node policies contain duplicates');
  return [...policies].sort(compareIdentity);
}

export function parseSideEffectClass(value: unknown): SideEffectClass {
  switch (value) {
    case 'safe':
    case 'idempotent_with_key':
    case 'unsafe':
      return value;
    default:
      fail('node side-effect class is invalid');
  }
}

export function sideEffectClass(
  retryClass: NodeManifest['retryClass'],
): SideEffectClass {
  switch (retryClass) {
    case 'safe':
      return 'safe';
    case 'idempotent-with-key':
      return 'idempotent_with_key';
    case 'unsafe':
      return 'unsafe';
    default:
      return unreachableRetryClass(retryClass);
  }
}

function unreachableRetryClass(value: never): never {
  fail(`unsupported retry class ${String(value)}`);
}

function executablePrimitiveBytes(
  item: unknown,
  remainingBytes: number,
): number | undefined {
  if (typeof item === 'string')
    return jsonStringByteLength(item, { stopAfterBytes: remainingBytes });
  if (typeof item === 'boolean') return item ? 4 : 5;
  if (typeof item === 'number' && Number.isFinite(item))
    return Object.is(item, -0) ? 1 : String(item).length;
  return undefined;
}
function assertExecutableContainer(
  item: object,
  depth: number,
  ancestors: ReadonlySet<object>,
): void {
  if (nodeTypes.isProxy(item))
    fail('executable envelope must not contain proxies');
  if (depth > WORKFLOW_EXECUTABLE_LIMITS.depth)
    fail('executable envelope exceeds maximum depth');
  if (ancestors.has(item)) fail('executable envelope must not contain cycles');
}
function assertExecutableOwnFields(
  item: object,
  {
    arrayLength,
    enumerableCount,
  }: Readonly<{ arrayLength: number | undefined; enumerableCount: number }>,
): void {
  const ownNames = Object.getOwnPropertyNames(item);
  if (Object.getOwnPropertySymbols(item).length !== 0)
    fail('executable envelope has symbol fields');
  const hiddenOrSparseFields =
    (arrayLength !== undefined &&
      (enumerableCount !== arrayLength ||
        ownNames.length !== arrayLength + 1 ||
        !ownNames.includes('length'))) ||
    (arrayLength === undefined && ownNames.length !== enumerableCount);
  if (hiddenOrSparseFields)
    fail('executable envelope has hidden or sparse fields');
}

function executableDataField(item: object, key: string): PropertyDescriptor {
  if (!Object.hasOwn(item, key))
    fail('executable envelope has inherited enumerable fields');
  const descriptor = Object.getOwnPropertyDescriptor(item, key);
  const invalidDataField =
    descriptor === undefined ||
    !descriptor.enumerable ||
    !('value' in descriptor);
  if (invalidDataField)
    fail('executable envelope must contain own data fields');
  return descriptor;
}
