import { WorkflowEngineError } from './errors.js';
import {
  type InvocationState,
  NODE_STATUSES,
  type WorkflowCheckpointV1,
  RUN_STATUSES,
  type BranchLedgerEntry,
  type OutputReference,
} from './types.js';
import { types as nodeTypes } from 'node:util';
import { invocationKey } from './scheduling.js';
import { compareOrdinal } from './ordering.js';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

export const WORKFLOW_CHECKPOINT_LIMITS_V1 = Object.freeze({
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
  const allowed = new Set([...required, ...optional]);
  const ownNames = Object.getOwnPropertyNames(value);
  assertCheckpoint(
    ownNames.every((key) => allowed.has(key)) &&
      required.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor !== undefined &&
          descriptor.enumerable &&
          'value' in descriptor
        );
      }) &&
      optional.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor === undefined ||
          (descriptor.enumerable && 'value' in descriptor)
        );
      }),
    'checkpoint contains missing or unknown fields',
  );
}

function isNodeStatus(value: unknown): value is InvocationState['status'] {
  return (
    typeof value === 'string' &&
    NODE_STATUSES.some((candidate) => candidate === value)
  );
}

export function isRunStatus(
  value: unknown,
): value is WorkflowCheckpointV1['runStatus'] {
  return (
    typeof value === 'string' &&
    RUN_STATUSES.some((candidate) => candidate === value)
  );
}

function isBranchDisposition(
  value: unknown,
): value is BranchLedgerEntry['disposition'] {
  return (
    typeof value === 'string' &&
    ['pending', 'arrived', 'skipped', 'missing', 'failed', 'canceled'].some(
      (candidate) => candidate === value,
    )
  );
}

export function assertBoundedCheckpointJson(value: unknown): void {
  const addBytes = (current: number, added: number): number => {
    const next = current + added;
    assertCheckpoint(
      next <= WORKFLOW_CHECKPOINT_LIMITS_V1.bytes,
      'checkpoint exceeds maximum bytes',
    );
    return next;
  };
  const stringBytes = (input: string): number => {
    let bytes = 2;
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      const escaped =
        code === 0x22 ||
        code === 0x5c ||
        code === 0x08 ||
        code === 0x0c ||
        code === 0x0a ||
        code === 0x0d ||
        code === 0x09;
      if (escaped) bytes = addBytes(bytes, 2);
      else if (code <= 0x1f) bytes = addBytes(bytes, 6);
      else if (code <= 0x7f) bytes = addBytes(bytes, 1);
      else if (code <= 0x7ff) bytes = addBytes(bytes, 2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = input.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes = addBytes(bytes, 4);
          index += 1;
        } else bytes = addBytes(bytes, 6);
      } else if (code >= 0xdc00 && code <= 0xdfff) bytes = addBytes(bytes, 6);
      else bytes = addBytes(bytes, 3);
    }
    return bytes;
  };
  const pending: { readonly value: unknown; readonly depth: number }[] = [
    { value, depth: 1 },
  ];
  const ancestors = new Set<object>();
  const exits = new Set<object>();
  let members = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const item = current.value;
    if (item === null) {
      bytes = addBytes(bytes, 4);
      continue;
    }
    if (typeof item === 'string') {
      bytes = addBytes(bytes, stringBytes(item));
      continue;
    }
    if (typeof item === 'boolean') {
      bytes = addBytes(bytes, item ? 4 : 5);
      continue;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      bytes = addBytes(bytes, Object.is(item, -0) ? 1 : String(item).length);
      continue;
    }
    assertCheckpoint(typeof item === 'object', 'checkpoint must contain JSON');
    assertCheckpoint(
      !nodeTypes.isProxy(item),
      'checkpoint must not contain proxy objects',
    );
    if (exits.has(item)) {
      exits.delete(item);
      ancestors.delete(item);
      continue;
    }
    assertCheckpoint(
      current.depth <= WORKFLOW_CHECKPOINT_LIMITS_V1.depth,
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
        item.length <= WORKFLOW_CHECKPOINT_LIMITS_V1.arrayItems,
        'checkpoint array is oversized',
      );
      bytes = addBytes(bytes, 2 + Math.max(0, item.length - 1));
    } else bytes = addBytes(bytes, 2);
    ancestors.add(item);
    exits.add(item);
    pending.push({ value: item, depth: current.depth });
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
        members <= WORKFLOW_CHECKPOINT_LIMITS_V1.members,
        'checkpoint exceeds maximum members',
      );
      if (isArray)
        assertCheckpoint(
          key === String(enumerableCount),
          'checkpoint array is sparse or has extra properties',
        );
      else {
        if (enumerableCount > 0) bytes = addBytes(bytes, 1);
        bytes = addBytes(bytes, stringBytes(key) + 1);
      }
      enumerableCount += 1;
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
    // JavaScript has no incremental own-name/symbol reflection. Perform it
    // only after length/member-bounded enumerable traversal, then discard the
    // arrays immediately after comparing hidden names and symbols.
    const ownNames = Object.getOwnPropertyNames(item);
    assertCheckpoint(
      ownNames.length <=
        WORKFLOW_CHECKPOINT_LIMITS_V1.members + (isArray ? 1 : 0),
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

export function sortedUnique(
  values: readonly string[],
  label: string,
): readonly string[] {
  assertCheckpoint(
    values.every((value) => value.length > 0),
    `${label} contains an empty key`,
  );
  const sorted = [...values].sort();
  assertCheckpoint(
    new Set(sorted).size === sorted.length,
    `${label} contains duplicates`,
  );
  return sorted;
}

export function parseOutputReference(
  value: unknown,
  label: string,
): OutputReference {
  assertCheckpoint(isRecord(value), `${label} must be an object`);
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  if (value.kind === 'inline') {
    assertExactKeys(value, ['kind', 'attemptId']);
    assertCheckpoint(
      typeof value.attemptId === 'string' && uuidPattern.test(value.attemptId),
      `${label} attemptId must be a canonical UUID`,
    );
    return { kind: value.kind, attemptId: value.attemptId };
  }
  if (value.kind === 'artifact') {
    assertExactKeys(value, ['kind', 'artifactId']);
    assertCheckpoint(
      typeof value.artifactId === 'string' &&
        uuidPattern.test(value.artifactId),
      `${label} artifactId must be a canonical UUID`,
    );
    return { kind: value.kind, artifactId: value.artifactId };
  }
  assertCheckpoint(false, `${label} kind is invalid`);
}

export function parseInvocation(value: unknown): InvocationState {
  assertCheckpoint(isRecord(value), 'invocation must be an object');
  assertExactKeys(
    value,
    ['invocationKey', 'nodeId', 'status', 'attemptNumber'],
    ['resumeAt', 'waitKind', 'output'],
  );
  assertCheckpoint(
    typeof value.invocationKey === 'string' && value.invocationKey.length > 0,
    'invocationKey is required',
  );
  assertCheckpoint(
    typeof value.nodeId === 'string' && value.nodeId.length > 0,
    'nodeId is required',
  );
  assertCheckpoint(isNodeStatus(value.status), 'invocation status is invalid');
  assertCheckpoint(
    isInteger(value.attemptNumber) && value.attemptNumber >= 0,
    'attemptNumber must be a non-negative integer',
  );
  if (value.resumeAt !== undefined) {
    assertCheckpoint(
      typeof value.resumeAt === 'string' &&
        Number.isFinite(Date.parse(value.resumeAt)),
      'resumeAt must be a valid timestamp',
    );
  }
  assertCheckpoint(
    value.resumeAt === undefined || value.status === 'waiting',
    'resumeAt must exist only for a waiting invocation',
  );
  assertCheckpoint(
    value.waitKind === undefined ||
      ((value.status === 'waiting' || value.status === 'ready') &&
        (value.waitKind === 'node_wait' || value.waitKind === 'retry_backoff')),
    'waitKind must identify delayed work only',
  );
  const output =
    value.output === undefined
      ? undefined
      : parseOutputReference(value.output, 'invocation output');
  return {
    invocationKey: value.invocationKey,
    nodeId: value.nodeId,
    status: value.status,
    attemptNumber: value.attemptNumber,
    ...(value.resumeAt === undefined ? {} : { resumeAt: value.resumeAt }),
    ...(value.waitKind === undefined ? {} : { waitKind: value.waitKind }),
    ...(output === undefined ? {} : { output }),
  };
}

export function parseV2Invocations(
  value: unknown,
  workflowVersionId: string,
): readonly InvocationState[] {
  assertCheckpoint(Array.isArray(value), 'invocations must be an array');
  return value.map((item) => {
    assertCheckpoint(isRecord(item), 'invocation must be an object');
    assertExactKeys(
      item,
      ['invocationKey', 'nodeId', 'status', 'attemptNumber'],
      ['resumeAt', 'waitKind', 'output', 'branchPath', 'iterationPath'],
    );
    const {
      branchPath: rawBranchPath,
      iterationPath: rawIterationPath,
      ...base
    } = item;
    const invocation = parseInvocation(base);
    assertCheckpoint(
      rawBranchPath === undefined || Array.isArray(rawBranchPath),
      'invocation branchPath must be an array',
    );
    const branchPath = (rawBranchPath ?? []).map((part) => {
      assertCheckpoint(isRecord(part), 'branch scope part must be an object');
      assertExactKeys(part, ['nodeId', 'outputPort']);
      assertCheckpoint(
        typeof part.nodeId === 'string' && part.nodeId.length > 0,
        'branch scope nodeId is required',
      );
      assertCheckpoint(
        typeof part.outputPort === 'string' && part.outputPort.length > 0,
        'branch scope outputPort is required',
      );
      return { nodeId: part.nodeId, outputPort: part.outputPort };
    });
    assertCheckpoint(
      rawIterationPath === undefined || Array.isArray(rawIterationPath),
      'invocation iterationPath must be an array',
    );
    const iterationPath = (rawIterationPath ?? []).map((part) => {
      assertCheckpoint(
        isRecord(part),
        'iteration scope part must be an object',
      );
      assertExactKeys(part, ['loopNodeId', 'ordinal']);
      assertCheckpoint(
        typeof part.loopNodeId === 'string' && part.loopNodeId.length > 0,
        'iteration scope loopNodeId is required',
      );
      assertCheckpoint(
        isInteger(part.ordinal) && part.ordinal >= 0,
        'iteration scope ordinal is invalid',
      );
      return { loopNodeId: part.loopNodeId, ordinal: part.ordinal };
    });
    assertCheckpoint(
      new Set(branchPath.map(({ nodeId }) => nodeId)).size ===
        branchPath.length,
      'branch scope node IDs must be unique',
    );
    if (rawBranchPath !== undefined || rawIterationPath !== undefined)
      assertCheckpoint(
        invocation.invocationKey ===
          invocationKey({
            workflowVersionId,
            nodeId: invocation.nodeId,
            branchPath: branchPath.map(
              ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
            ),
            iterationPath,
          }),
        'invocation key disagrees with branch scope',
      );
    return rawBranchPath === undefined && rawIterationPath === undefined
      ? invocation
      : { ...invocation, branchPath, iterationPath };
  });
}

export function parseLedger(value: unknown): readonly BranchLedgerEntry[] {
  assertCheckpoint(Array.isArray(value), 'join ledger must be an array');
  const allowed: readonly BranchLedgerEntry['disposition'][] = [
    'pending',
    'arrived',
    'skipped',
    'missing',
    'failed',
    'canceled',
  ];
  const ledger = value.map((entry): BranchLedgerEntry => {
    assertCheckpoint(isRecord(entry), 'branch ledger entry must be an object');
    assertExactKeys(entry, ['branchId', 'disposition'], ['output']);
    assertCheckpoint(
      typeof entry.branchId === 'string' && entry.branchId.length > 0,
      'branchId is required',
    );
    assertCheckpoint(
      isBranchDisposition(entry.disposition) &&
        allowed.some((candidate) => candidate === entry.disposition),
      'branch disposition is invalid',
    );
    const output =
      entry.output === undefined
        ? undefined
        : parseOutputReference(entry.output, 'branch output');
    return {
      branchId: entry.branchId,
      disposition: entry.disposition,
      ...(output === undefined ? {} : { output }),
    };
  });
  return [...ledger].sort((left, right) =>
    compareOrdinal(left.branchId, right.branchId),
  );
}
