import { jsonStringByteLength } from '@pertexo/workflow-model';
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
import type { SideEffectClass } from '../workflow-execution.js';
import type { ExecutableRuntimePolicies } from './workflow-executable.js';
import { WORKFLOW_EXECUTABLE_LIMITS } from './runtime-policies.js';
import { compareIdentity, token } from './definition-identity.js';
import { fail } from './executable-errors.js';

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

type JsonBounds = Readonly<{ bytes: number; depth: number; members: number }>;

function assertSafeExecutableJson(
  value: unknown,
  limits: JsonBounds = WORKFLOW_EXECUTABLE_LIMITS,
): void {
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
    if (bytes > limits.bytes) fail('executable envelope exceeds maximum bytes');
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
    const primitiveBytes = executablePrimitiveBytes(item, limits.bytes - bytes);
    if (primitiveBytes !== undefined) {
      add(primitiveBytes);
      continue;
    }
    if (typeof item !== 'object') fail('executable envelope must contain JSON');
    assertExecutableContainer(item, frame.depth, ancestors, limits.depth);
    const isArray = Array.isArray(item);
    const prototype: object | null = Object.getPrototypeOf(item) as
      object | null;
    const plainContainer =
      isArray || prototype === Object.prototype || prototype === null;
    if (!plainContainer) fail('executable envelope must contain plain objects');
    if (isArray && item.length > limits.members)
      fail('executable envelope array is oversized');
    add(2 + (isArray ? Math.max(0, item.length - 1) : 0));
    ancestors.add(item);
    pending.push({ kind: 'exit', value: item });
    let enumerableCount = 0;
    for (const key of Object.keys(item)) {
      members += 1;
      if (members > limits.members)
        fail('executable envelope exceeds maximum members');
      if (isArray && key !== String(enumerableCount))
        fail('executable envelope array is sparse or has extra fields');
      if (!isArray) {
        if (enumerableCount > 0) add(1);
        add(
          jsonStringByteLength(key, {
            stopAfterBytes: limits.bytes - bytes,
          }),
        );
        add(1);
      }
      enumerableCount += 1;
      pending.push({
        kind: 'value',
        value: (item as Readonly<Record<string, unknown>>)[key],
        depth: frame.depth + 1,
      });
    }
    assertNotSparse(item, enumerableCount);
  }
}

/** Engine structures, with sorted keys so they compare by their text. */
export function normalizeBoundedEngineJson(
  value: unknown,
  limits?: JsonBounds,
): JsonValue {
  assertSafeExecutableJson(value, limits);
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

/** Data a step reads or returns, keeping the key order it was written in. */
export function normalizeBoundedEngineValue(
  value: unknown,
  limits?: JsonBounds,
): JsonValue {
  assertSafeExecutableJson(value, limits);
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
  maximumDepth: number,
): void {
  if (depth > maximumDepth) fail('executable envelope exceeds maximum depth');
  if (ancestors.has(item)) fail('executable envelope must not contain cycles');
}

function assertNotSparse(item: object, enumerableCount: number): void {
  if (Array.isArray(item) && enumerableCount !== item.length)
    fail('executable envelope array is sparse');
}
