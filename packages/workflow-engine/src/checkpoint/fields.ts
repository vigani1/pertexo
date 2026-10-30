import { UUID_PATTERN } from '@pertexo/workflow-model';
import { isRecord } from '@pertexo/workflow-model';

import {
  type InvocationState,
  type InvocationWait,
  NODE_STATUSES,
  type NodeStatus,
  type RunStatus,
  RUN_STATUSES,
  type BranchLedgerEntry,
  type OutputReference,
  type BranchScopePart,
  type IterationScopePart,
} from '../types.js';

import { invocationKey } from '../transition/scheduling/loops.js';
import { compareOrdinal } from '@pertexo/workflow-model';
import { WorkflowEngineError } from '../errors.js';
import { assertCanonicalTimestamp } from './identity.js';
import { isInteger, assertCheckpoint, assertExactKeys } from './admission.js';

export {
  isInteger,
  WORKFLOW_CHECKPOINT_LIMITS,
  assertCheckpoint,
  assertExactKeys,
  assertBoundedCheckpointJson,
} from './admission.js';
function isNodeStatus(value: unknown): value is InvocationState['status'] {
  return (
    typeof value === 'string' &&
    NODE_STATUSES.some((candidate) => candidate === value)
  );
}

export function isRunStatus(value: unknown): value is RunStatus {
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
  if (value.kind === 'inline') {
    assertExactKeys(value, ['kind', 'attemptId']);
    assertCheckpoint(
      typeof value.attemptId === 'string' && UUID_PATTERN.test(value.attemptId),
      `${label} attemptId must be a canonical UUID`,
    );
    return { kind: value.kind, attemptId: value.attemptId };
  }
  if (value.kind === 'task') {
    assertExactKeys(value, ['kind', 'taskId']);
    assertCheckpoint(
      typeof value.taskId === 'string' && UUID_PATTERN.test(value.taskId),
      `${label} taskId must be a canonical UUID`,
    );
    return { kind: value.kind, taskId: value.taskId };
  }
  if (value.kind === 'call') {
    assertExactKeys(value, ['kind', 'callId']);
    assertCheckpoint(
      typeof value.callId === 'string' && UUID_PATTERN.test(value.callId),
      `${label} callId must be a canonical UUID`,
    );
    return { kind: value.kind, callId: value.callId };
  }
  if (value.kind === 'reused') {
    assertExactKeys(value, ['kind', 'nodeRunId']);
    assertCheckpoint(
      typeof value.nodeRunId === 'string' && UUID_PATTERN.test(value.nodeRunId),
      `${label} nodeRunId must be a canonical UUID`,
    );
    return { kind: value.kind, nodeRunId: value.nodeRunId };
  }
  if (value.kind === 'artifact') {
    assertExactKeys(value, ['kind', 'artifactId']);
    assertCheckpoint(
      typeof value.artifactId === 'string' &&
        UUID_PATTERN.test(value.artifactId),
      `${label} artifactId must be a canonical UUID`,
    );
    return { kind: value.kind, artifactId: value.artifactId };
  }
  assertCheckpoint(false, `${label} kind is invalid`);
}

function parseInvocation(value: unknown): InvocationState {
  assertCheckpoint(isRecord(value), 'invocation must be an object');
  assertExactKeys(
    value,
    ['invocationKey', 'nodeId', 'status', 'attemptNumber'],
    ['resumeAt', 'waitKind', 'output', 'failureHandling'],
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
  const resumeAt =
    value.resumeAt === undefined
      ? undefined
      : assertCanonicalTimestamp(value.resumeAt, 'resumeAt');
  assertCheckpoint(
    value.resumeAt === undefined || value.status === 'waiting',
    'resumeAt must exist only for a waiting invocation',
  );
  const wait = parseInvocationWait(value.status, value.waitKind, resumeAt);
  const output =
    value.output === undefined
      ? undefined
      : parseOutputReference(value.output, 'invocation output');
  assertCheckpoint(
    output?.kind !== 'reused' ||
      (value.status === 'succeeded' &&
        value.attemptNumber === 0 &&
        value.waitKind === undefined &&
        resumeAt === undefined),
    'reused output must belong to a completed invocation without attempts',
  );
  const failureHandling = parseFailureHandling(value.failureHandling, {
    status: value.status,
    attemptNumber: value.attemptNumber,
  });
  return {
    invocationKey: value.invocationKey,
    nodeId: value.nodeId,
    ...wait,
    attemptNumber: value.attemptNumber,
    ...(output === undefined ? {} : { output }),
    ...(failureHandling === undefined ? {} : { failureHandling }),
  };
}

export function parseBranchPath(
  value: unknown,
  subject: 'invocation' | 'join' | 'loop',
): readonly BranchScopePart[] {
  const invocation = subject === 'invocation';
  const label = invocation ? 'branch scope' : `${subject} branch scope`;
  assertCheckpoint(
    value === undefined || Array.isArray(value),
    invocation
      ? 'invocation branchPath must be an array'
      : `${label} must be an array`,
  );
  return (value ?? []).map((part) => {
    assertCheckpoint(
      isRecord(part),
      invocation
        ? 'branch scope part must be an object'
        : `${label} must be an object`,
    );
    assertExactKeys(part, ['nodeId', 'outputPort']);
    assertCheckpoint(
      typeof part.nodeId === 'string' && part.nodeId.length > 0,
      invocation ? 'branch scope nodeId is required' : `${label} is invalid`,
    );
    assertCheckpoint(
      typeof part.outputPort === 'string' && part.outputPort.length > 0,
      invocation
        ? 'branch scope outputPort is required'
        : `${label} is invalid`,
    );
    return { nodeId: part.nodeId, outputPort: part.outputPort };
  });
}

export function parseIterationPath(
  value: unknown,
  subject: 'invocation' | 'join' | 'loop',
): readonly IterationScopePart[] {
  const invocation = subject === 'invocation';
  const label = invocation ? 'iteration scope' : `${subject} iteration scope`;
  assertCheckpoint(
    value === undefined || Array.isArray(value),
    invocation
      ? 'invocation iterationPath must be an array'
      : `${label} must be an array`,
  );
  return (value ?? []).map((part) => {
    assertCheckpoint(
      isRecord(part),
      invocation
        ? 'iteration scope part must be an object'
        : `${label} must be an object`,
    );
    assertExactKeys(part, ['loopNodeId', 'ordinal']);
    assertCheckpoint(
      typeof part.loopNodeId === 'string' && part.loopNodeId.length > 0,
      invocation
        ? 'iteration scope loopNodeId is required'
        : `${label} is invalid`,
    );
    assertCheckpoint(
      isInteger(part.ordinal) && part.ordinal >= 0,
      invocation ? 'iteration scope ordinal is invalid' : `${label} is invalid`,
    );
    return { loopNodeId: part.loopNodeId, ordinal: part.ordinal };
  });
}

export function parseInvocations(
  value: unknown,
  workflowVersionId: string,
): readonly InvocationState[] {
  assertCheckpoint(Array.isArray(value), 'invocations must be an array');
  return value.map((item) => {
    assertCheckpoint(isRecord(item), 'invocation must be an object');
    assertExactKeys(
      item,
      ['invocationKey', 'nodeId', 'status', 'attemptNumber'],
      [
        'resumeAt',
        'waitKind',
        'output',
        'branchPath',
        'iterationPath',
        'failureHandling',
      ],
    );
    const {
      branchPath: rawBranchPath,
      iterationPath: rawIterationPath,
      ...base
    } = item;
    const invocation = parseInvocation(base);
    const branchPath = parseBranchPath(rawBranchPath, 'invocation');
    const iterationPath = parseIterationPath(rawIterationPath, 'invocation');
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
  const ledger = value.map((entry): BranchLedgerEntry => {
    assertCheckpoint(isRecord(entry), 'branch ledger entry must be an object');
    assertExactKeys(entry, ['branchId', 'disposition'], ['output']);
    assertCheckpoint(
      typeof entry.branchId === 'string' && entry.branchId.length > 0,
      'branchId is required',
    );
    assertCheckpoint(
      isBranchDisposition(entry.disposition),
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

function parseInvocationWait(
  status: NodeStatus,
  waitKind: unknown,
  resumeAt: string | undefined,
): InvocationWait {
  const invalidWait = (): never => {
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      'waitKind must identify delayed work only',
    );
  };
  if (waitKind === undefined)
    return status === 'waiting' && resumeAt !== undefined
      ? { status, resumeAt }
      : { status };
  if (waitKind === 'node_wait' || waitKind === 'retry_backoff') {
    if (status === 'waiting')
      return {
        status,
        waitKind,
        ...(resumeAt === undefined ? {} : { resumeAt }),
      };
    return status === 'ready' ? { status, waitKind } : invalidWait();
  }
  return (waitKind === 'workflow_call' || waitKind === 'human_task') &&
    status === 'waiting' &&
    resumeAt === undefined
    ? { status, waitKind }
    : invalidWait();
}

function parseFailureHandling(
  raw: unknown,
  {
    status,
    attemptNumber,
  }: Readonly<{ status: InvocationState['status']; attemptNumber: number }>,
): InvocationState['failureHandling'] {
  if (raw === undefined) return undefined;
  const handling = raw;
  assertCheckpoint(
    isRecord(handling) && status === 'failed' && attemptNumber > 0,
    'handling requires an executed failed source',
  );
  assertExactKeys(handling, ['sinkInvocationKey', 'disposition']);
  assertCheckpoint(
    typeof handling.sinkInvocationKey === 'string' &&
      handling.sinkInvocationKey.length > 0 &&
      ['pending', 'handled'].includes(String(handling.disposition)),
    'handling identity or disposition is invalid',
  );
  return {
    sinkInvocationKey: handling.sinkInvocationKey,
    disposition: handling.disposition as 'pending' | 'handled',
  };
}
