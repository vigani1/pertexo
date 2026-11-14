import type {
  DefinitionIdentity,
  NodeManifest,
  PolicyReference,
} from '@pertexo/node-sdk';
import {
  canonicalJson,
  isRecord,
  measureBoundedJson,
  type BoundedJsonSizeRefusal,
  normalizedJson,
  type JsonValue,
} from '@pertexo/workflow-model';
import { hasExactFields } from '../input-checks/exact-fields.js';
import type { SideEffectClass } from '../workflow-execution.js';
import type { ExecutableRuntimePolicies } from './workflow-executable.js';
import { WORKFLOW_EXECUTABLE_LIMITS } from './runtime-policies.js';
import { compareIdentity, token } from './definition-identity.js';
import { fail } from './executable.errors.js';

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

const EXECUTABLE_JSON_REFUSALS: Readonly<
  Record<BoundedJsonSizeRefusal, string>
> = {
  bytes: 'executable envelope exceeds maximum bytes',
  depth: 'executable envelope exceeds maximum depth',
  members: 'executable envelope exceeds maximum members',
  array_items: 'executable envelope array is oversized',
  not_json: 'executable envelope must contain JSON',
  cycle: 'executable envelope must not contain cycles',
  not_plain: 'executable envelope must contain plain objects',
  array_extra_keys: 'executable envelope array is sparse or has extra fields',
  sparse_array: 'executable envelope array is sparse',
};

function assertSafeExecutableJson(
  value: unknown,
  limits: JsonBounds = WORKFLOW_EXECUTABLE_LIMITS,
): void {
  const measured = measureBoundedJson(value, limits);
  if (!measured.ok) fail(EXECUTABLE_JSON_REFUSALS[measured.refusal]);
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
