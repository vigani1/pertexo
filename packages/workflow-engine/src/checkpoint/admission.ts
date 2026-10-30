import { jsonStringByteLength } from '@pertexo/workflow-model';

import { WorkflowEngineError } from '../errors.js';
import { hasExactFields } from '../exact-fields.js';

import { types as nodeTypes } from 'node:util';

export const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

export const WORKFLOW_CHECKPOINT_LIMITS = Object.freeze({
  bytes: 262_144,
  depth: 64,
  members: 10_000,
  arrayItems: 10_000,
});

export function assertCheckpoint(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new WorkflowEngineError('checkpoint_invalid', message);
}

export function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  assertCheckpoint(
    hasExactFields(value, required, optional),
    'checkpoint contains missing or unknown fields',
  );
}

export function assertBoundedCheckpointJson(value: unknown): void {
  const addBytes = (current: number, added: number): number => {
    const next = current + added;
    assertCheckpoint(
      next <= WORKFLOW_CHECKPOINT_LIMITS.bytes,
      'checkpoint exceeds maximum bytes',
    );
    return next;
  };
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
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    if (current.kind === 'exit') {
      ancestors.delete(current.value);
      continue;
    }
    const item = current.value;
    if (item === null) {
      bytes = addBytes(bytes, 4);
      continue;
    }
    const primitiveBytes = checkpointPrimitiveBytes(item);
    if (primitiveBytes !== undefined) {
      bytes = addBytes(bytes, primitiveBytes);
      continue;
    }
    assertCheckpoint(typeof item === 'object', 'checkpoint must contain JSON');
    assertCheckpoint(
      !nodeTypes.isProxy(item),
      'checkpoint must not contain proxy objects',
    );
    assertCheckpoint(
      current.depth <= WORKFLOW_CHECKPOINT_LIMITS.depth,
      'checkpoint exceeds maximum depth',
    );
    assertCheckpoint(
      !ancestors.has(item),
      'checkpoint must not contain cycles',
    );
    const isArray = Array.isArray(item);
    const prototype: object | null = Object.getPrototypeOf(item) as
      object | null;
    assertCheckpoint(
      isArray || prototype === Object.prototype || prototype === null,
      'checkpoint must contain plain JSON objects',
    );
    if (isArray) {
      assertCheckpoint(
        item.length <= WORKFLOW_CHECKPOINT_LIMITS.arrayItems,
        'checkpoint array is oversized',
      );
      bytes = addBytes(bytes, 2 + Math.max(0, item.length - 1));
    } else bytes = addBytes(bytes, 2);
    ancestors.add(item);
    pending.push({ kind: 'exit', value: item });
    let enumerableCount = 0;
    for (const key in item) {
      assertCheckpoint(
        Object.hasOwn(item, key),
        'checkpoint must not contain inherited enumerable properties',
      );
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      assertCheckpoint(
        descriptor !== undefined &&
          descriptor.enumerable &&
          'value' in descriptor,
        'checkpoint must not contain accessors',
      );
      members += 1;
      assertCheckpoint(
        members <= WORKFLOW_CHECKPOINT_LIMITS.members,
        'checkpoint exceeds maximum members',
      );
      if (isArray)
        assertCheckpoint(
          key === String(enumerableCount),
          'checkpoint array is sparse or has extra properties',
        );
      else {
        if (enumerableCount > 0) bytes = addBytes(bytes, 1);
        bytes = addBytes(
          bytes,
          jsonStringByteLength(key, {
            stopAfterBytes: WORKFLOW_CHECKPOINT_LIMITS.bytes,
          }) + 1,
        );
      }
      enumerableCount += 1;
      pending.push({
        kind: 'value',
        value: descriptor.value,
        depth: current.depth + 1,
      });
    }
    // JavaScript has no incremental own-name/symbol reflection. Perform it
    // only after length/member-bounded enumerable traversal, then discard the
    // arrays immediately after comparing hidden names and symbols.
    const ownNames = Object.getOwnPropertyNames(item);
    assertCheckpoint(
      ownNames.length <= WORKFLOW_CHECKPOINT_LIMITS.members + (isArray ? 1 : 0),
      'checkpoint exceeds maximum own properties',
    );
    assertCheckpoint(
      Object.getOwnPropertySymbols(item).length === 0,
      'checkpoint must not contain symbol properties',
    );
    if (isArray)
      assertCheckpoint(
        enumerableCount === item.length &&
          ownNames.length === item.length + 1 &&
          ownNames.includes('length'),
        'checkpoint array is sparse or has hidden properties',
      );
    else
      assertCheckpoint(
        ownNames.length === enumerableCount,
        'checkpoint object has hidden properties',
      );
  }
}

function checkpointPrimitiveBytes(item: unknown): number | undefined {
  if (typeof item === 'string')
    return jsonStringByteLength(item, {
      stopAfterBytes: WORKFLOW_CHECKPOINT_LIMITS.bytes,
    });
  if (typeof item === 'boolean') return item ? 4 : 5;
  if (typeof item === 'number' && Number.isFinite(item))
    return Object.is(item, -0) ? 1 : String(item).length;
  return undefined;
}
