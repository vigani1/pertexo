import { types as nodeTypes } from 'node:util';
import {
  NODE_JSON_LIMITS_V1,
  type DefinitionIdentity,
  type NodeManifest,
  type PolicyReference,
  type RegistryRelease,
} from '@pertexo/node-sdk';
import {
  canonicalJson,
  type JsonValue,
} from '@pertexo/workflow-model/canonical-json';
import type { SideEffectClass } from './types.js';
import {
  type ExecutableRuntimePoliciesV1,
  WORKFLOW_EXECUTABLE_LIMITS_V2,
  compareIdentity,
  compareOrdinal,
  fail,
  token,
} from './executable-foundation.js';

export function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  )
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
    if (bytes > WORKFLOW_EXECUTABLE_LIMITS_V2.bytes)
      fail('executable envelope exceeds maximum bytes');
  };
  const addString = (input: string): void => {
    add(2);
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
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
        const next = input.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          add(4);
          index += 1;
        } else add(6);
      } else if (code >= 0xdc00 && code <= 0xdfff) add(6);
      else add(3);
    }
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
    if (typeof item === 'string') {
      addString(item);
      continue;
    }
    if (typeof item === 'boolean') {
      add(item ? 4 : 5);
      continue;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      add(Object.is(item, -0) ? 1 : String(item).length);
      continue;
    }
    if (typeof item !== 'object') fail('executable envelope must contain JSON');
    if (nodeTypes.isProxy(item))
      fail('executable envelope must not contain proxies');
    if (frame.depth > NODE_JSON_LIMITS_V1.depth)
      fail('executable envelope exceeds maximum depth');
    if (ancestors.has(item))
      fail('executable envelope must not contain cycles');
    const isArray = Array.isArray(item);
    const prototype: object | null = Object.getPrototypeOf(item) as
      object | null;
    if (!isArray && prototype !== Object.prototype && prototype !== null)
      fail('executable envelope must contain plain objects');
    if (isArray && item.length > NODE_JSON_LIMITS_V1.members)
      fail('executable envelope array is oversized');
    add(2 + (isArray ? Math.max(0, item.length - 1) : 0));
    ancestors.add(item);
    pending.push({ kind: 'exit', value: item });
    let enumerableCount = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key))
        fail('executable envelope has inherited enumerable fields');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      )
        fail('executable envelope must contain own data fields');
      members += 1;
      if (members > NODE_JSON_LIMITS_V1.members)
        fail('executable envelope exceeds maximum members');
      if (isArray && key !== String(enumerableCount))
        fail('executable envelope array is sparse or has extra fields');
      if (!isArray) {
        if (enumerableCount > 0) add(1);
        addString(key);
        add(1);
      }
      enumerableCount += 1;
      pending.push({
        kind: 'value',
        value: descriptor.value,
        depth: frame.depth + 1,
      });
    }
    const ownNames = Object.getOwnPropertyNames(item);
    if (Object.getOwnPropertySymbols(item).length !== 0)
      fail('executable envelope has symbol fields');
    if (
      (isArray &&
        (enumerableCount !== item.length ||
          ownNames.length !== item.length + 1 ||
          !ownNames.includes('length'))) ||
      (!isArray && ownNames.length !== enumerableCount)
    )
      fail('executable envelope has hidden or sparse fields');
  }
}

export function normalizeBoundedEngineJson(value: unknown): JsonValue {
  assertSafeExecutableJson(value);
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

export function parseIdentity(
  value: unknown,
  label: string,
): DefinitionIdentity {
  const identity = record(value, label);
  exactKeys(identity, ['key', 'version']);
  if (
    typeof identity.key !== 'string' ||
    !/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u.test(identity.key) ||
    typeof identity.version !== 'number' ||
    !Number.isSafeInteger(identity.version) ||
    identity.version < 1
  )
    fail(`${label} is invalid`);
  return { key: identity.key, version: identity.version };
}

export function parseGlobals(value: unknown): ExecutableRuntimePoliciesV1 {
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

export function immutableDefinitionBehavior(manifest: NodeManifest): unknown {
  return {
    schemaVersion: manifest.schemaVersion,
    definition: manifest.definition,
    family: manifest.family,
    configVersion: manifest.configVersion,
    configSchema: manifest.configSchema,
    inputSchema: manifest.inputSchema,
    outputSchema: manifest.outputSchema,
    ports: {
      inputs: [...manifest.ports.inputs].sort(compareOrdinal),
      outputs: [...manifest.ports.outputs].sort(compareOrdinal),
    },
    credentialRequirements: [...manifest.credentialRequirements].sort(
      compareOrdinal,
    ),
    connectionRequirements: [...manifest.connectionRequirements].sort(
      compareOrdinal,
    ),
    retryClass: manifest.retryClass,
    resourceClass: manifest.resourceClass,
    capabilities: [...manifest.capabilities].sort(compareOrdinal),
    executor: manifest.executor,
    executorAbi: manifest.executorAbi,
    policyReferences: [...manifest.policyReferences].sort(compareIdentity),
  };
}

export function immutableExecutorBehavior(
  manifest: RegistryRelease['executors'][number],
): unknown {
  return {
    executor: manifest.executor,
    abiVersion: manifest.abiVersion,
    definitions: [...manifest.definitions].sort(compareIdentity),
    policyReferences: [...manifest.policyReferences].sort(compareIdentity),
  };
}
