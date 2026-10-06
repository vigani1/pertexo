import {
  WORKFLOW_CALL_FAMILY_POLICY_V1,
  workflowCallPinSchemaV1,
} from '@pertexo/workflow-model/workflow-call-contract';
import { WorkflowEngineError } from '../errors.js';
import { compareOrdinal } from '../ordering.js';
import { invocationKey } from '../transition/scheduling.js';
import {
  WORKFLOW_CALL_REFUSAL_CODES_V1,
  type WorkflowCallInvocationStateV1,
  type WorkflowCallResultReferenceV1,
  type WorkflowCallStateV1,
  type WorkflowCheckpointV3,
} from '../workflow-call-state.js';
import type { WorkflowCheckpointV2 } from '../types.js';
import { createCheckpointV2 } from './checkpoint-initial.js';
import {
  assertBoundedCheckpointJson,
  assertCheckpoint,
  assertExactKeys,
  isRecord,
  parseOutputReference,
} from './checkpoint-shared.js';
import { parseCheckpointV2Boundary } from './checkpoint-v2.js';

export function createWorkflowCheckpointV3(
  input: Parameters<typeof createCheckpointV2>[0],
): WorkflowCheckpointV3 {
  return { ...createCheckpointV2(input), schemaVersion: 3, calls: [] };
}

function canonicalUuid(value: unknown, label: string): string {
  const reference = parseOutputReference(
    { kind: 'inline', attemptId: value },
    label,
  );
  assertCheckpoint(reference.kind === 'inline', `${label} is invalid`);
  return reference.attemptId;
}

function parseCall(value: unknown): WorkflowCallStateV1 {
  assertCheckpoint(isRecord(value), 'call must be an object');
  const required = [
    'invocationKey',
    'nodeId',
    'declarationAttemptId',
    'pin',
    'input',
    'inputChecksum',
    'status',
  ];
  const status = value.status;
  const extra =
    status === 'admitted'
      ? ['childRunId']
      : status === 'settled'
        ? ['childRunId', 'childStatus']
        : status === 'refused' || status === 'aborted'
          ? ['reasonCode']
          : [];
  assertExactKeys(value, [...required, ...extra]);
  assertCheckpoint(
    typeof value.invocationKey === 'string' && value.invocationKey.length > 0,
    'call invocationKey is required',
  );
  assertCheckpoint(
    typeof value.nodeId === 'string' && value.nodeId.length > 0,
    'call nodeId is required',
  );
  const declarationAttemptId = canonicalUuid(
    value.declarationAttemptId,
    'call declaration attempt',
  );
  const pin = workflowCallPinSchemaV1.safeParse(value.pin);
  assertCheckpoint(pin.success, 'call pin is invalid');
  const input = parseOutputReference(value.input, 'call input');
  assertCheckpoint(
    input.kind !== 'inline' || input.attemptId === declarationAttemptId,
    'call inline input must identify its declaration attempt',
  );
  assertCheckpoint(
    typeof value.inputChecksum === 'string' &&
      /^[0-9a-f]{64}$/.test(value.inputChecksum),
    'call input checksum is invalid',
  );
  const base = {
    invocationKey: value.invocationKey,
    nodeId: value.nodeId,
    declarationAttemptId,
    pin: pin.data,
    input,
    inputChecksum: value.inputChecksum,
  };
  if (status === 'awaiting_admission') return { ...base, status };
  if (status === 'admitted')
    return {
      ...base,
      status,
      childRunId: canonicalUuid(value.childRunId, 'call child run'),
    };
  if (status === 'refused') {
    const reasonCode = WORKFLOW_CALL_REFUSAL_CODES_V1.find(
      (candidate) => candidate === value.reasonCode,
    );
    assertCheckpoint(
      reasonCode !== undefined,
      'call refusal reason is invalid',
    );
    return { ...base, status, reasonCode };
  }
  if (status === 'aborted') {
    assertCheckpoint(
      value.reasonCode === 'workflow.canceled' ||
        value.reasonCode === 'workflow.timed_out',
      'call abort reason is invalid',
    );
    return { ...base, status, reasonCode: value.reasonCode };
  }
  assertCheckpoint(status === 'settled', 'call status is invalid');
  const childStatus = value.childStatus;
  assertCheckpoint(
    childStatus === 'succeeded' ||
      childStatus === 'failed' ||
      childStatus === 'canceled' ||
      childStatus === 'timed_out' ||
      childStatus === 'outcome_unknown',
    'call child status is invalid',
  );
  return {
    ...base,
    status,
    childRunId: canonicalUuid(value.childRunId, 'call child run'),
    childStatus,
  };
}

/** Snapshot only after the shared hostile-JSON preflight; never invoke accessors. */
function snapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snapshot);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(value))
    result[key] = snapshot(Object.getOwnPropertyDescriptor(value, key)?.value);
  return result;
}

function assertCallInvocation(
  call: WorkflowCallStateV1,
  entry: WorkflowCallInvocationStateV1 | undefined,
  raw: Record<string, unknown> | undefined,
  parsed: WorkflowCheckpointV2,
): void {
  assertCheckpoint(
    entry !== undefined &&
      raw !== undefined &&
      entry.nodeId === call.nodeId &&
      entry.attemptNumber === 1 &&
      parsed.admittedInvocationKeys.includes(call.invocationKey) &&
      !parsed.readySet.includes(call.invocationKey),
    'call must identify its admitted first attempt',
  );
  assertCheckpoint(
    invocationKey({
      workflowVersionId: parsed.workflowVersionId,
      nodeId: entry.nodeId,
      ...(entry.branchPath === undefined
        ? {}
        : {
            branchPath: entry.branchPath.map(
              (part) => `${part.nodeId}:${part.outputPort}`,
            ),
          }),
      ...(entry.iterationPath === undefined
        ? {}
        : { iterationPath: entry.iterationPath }),
    }) === call.invocationKey,
    'call invocation scope is invalid',
  );
  assertCheckpoint(
    !parsed.joins.some((join) => join.joinId === call.nodeId) &&
      !parsed.loops.some((loop) => loop.loopId === call.nodeId),
    'call cannot also be join or loop control',
  );
  assertCheckpoint(
    raw.resumeAt === undefined && raw.waitKind === undefined,
    'call cannot carry ordinary wait state',
  );
  const stopped = (status: string): boolean =>
    (status === 'canceled' && parsed.cancelRequested) ||
    (status === 'timed_out' && parsed.deadlineExpired);
  if (call.status === 'awaiting_admission' || call.status === 'admitted') {
    assertCheckpoint(
      raw.status === 'waiting' && entry.output === undefined,
      'unsettled call requires a dedicated waiting invocation',
    );
  } else if (call.status === 'aborted') {
    assertCheckpoint(
      call.reasonCode === 'workflow.canceled'
        ? entry.status === 'canceled' && parsed.cancelRequested
        : entry.status === 'timed_out' && parsed.deadlineExpired,
      'aborted call must match parent stop',
    );
  } else if (
    call.status === 'settled' &&
    call.childStatus === 'outcome_unknown'
  ) {
    assertCheckpoint(
      entry.status === 'outcome_unknown',
      'unknown child must remain outcome unknown',
    );
    assertCheckpoint(
      ['queued', 'running', 'waiting', 'outcome_unknown'].includes(
        parsed.runStatus,
      ),
      'terminal parent cannot mask unknown child',
    );
  } else if (call.status === 'settled' && call.childStatus === 'succeeded') {
    assertCheckpoint(
      entry.status === 'succeeded' || stopped(entry.status),
      'successful child must have a successful or stop-matched invocation',
    );
    if (entry.status === 'succeeded')
      assertCheckpoint(
        entry.output?.kind === 'workflow_call' &&
          entry.output.invocationKey === call.invocationKey &&
          entry.output.childRunId === call.childRunId,
        'successful call requires its own child result',
      );
  } else
    assertCheckpoint(
      entry.status === 'failed' || stopped(entry.status),
      'unsuccessful call must fail or match parent stop',
    );
  assertCheckpoint(
    entry.output === undefined ||
      (call.status === 'settled' &&
        call.childStatus === 'succeeded' &&
        entry.status === 'succeeded'),
    'call output requires child and invocation success',
  );
}

function parseCallLedger(value: readonly unknown[]): WorkflowCallStateV1[] {
  assertCheckpoint(
    value.length <= WORKFLOW_CALL_FAMILY_POLICY_V1.maxChildRuns,
    'checkpoint exceeds maximum Call declarations',
  );
  const calls = value
    .map(parseCall)
    .sort((a, b) => compareOrdinal(a.invocationKey, b.invocationKey));
  assertCheckpoint(
    new Set(calls.map((call) => call.invocationKey)).size === calls.length,
    'duplicate call invocation identity',
  );
  assertCheckpoint(
    new Set(calls.map((call) => call.declarationAttemptId)).size ===
      calls.length,
    'duplicate call declaration attempt',
  );
  const childIds = calls.flatMap((call) =>
    'childRunId' in call ? [call.childRunId] : [],
  );
  assertCheckpoint(
    new Set(childIds).size === childIds.length,
    'duplicate call child run',
  );
  return calls;
}

function parseBoundary(value: unknown): WorkflowCheckpointV3 {
  assertBoundedCheckpointJson(value);
  const source = snapshot(value);
  assertCheckpoint(isRecord(source), 'checkpoint must be an object');
  assertExactKeys(
    source,
    [
      'schemaVersion',
      'engineVersion',
      'workflowVersionId',
      'revision',
      'runStatus',
      'nextEventSequence',
      'readySet',
      'admittedInvocationKeys',
      'invocations',
      'joins',
      'loops',
      'remainingIterationBudget',
      'cancelRequested',
      'branchSelections',
      'calls',
    ],
    ['deadlineExpired', 'initialIterationBudget'],
  );
  assertCheckpoint(
    source.schemaVersion === 3,
    'checkpoint schema version must be 3',
  );
  assertCheckpoint(
    Array.isArray(source.calls) &&
      Array.isArray(source.invocations) &&
      Array.isArray(source.joins) &&
      Array.isArray(source.loops),
    'checkpoint state must be arrays',
  );
  const calls = parseCallLedger(source.calls);
  const callsByKey = new Map(calls.map((call) => [call.invocationKey, call]));
  const originalOutputs = new Map<string, WorkflowCallResultReferenceV1>();
  const ledgerOutputs = new Map<
    string,
    Map<string, WorkflowCallResultReferenceV1>
  >();
  const rawInvocations = source.invocations.map((entry) => {
    assertCheckpoint(isRecord(entry), 'invocation must be an object');
    return entry;
  });
  const rawByKey = new Map(
    rawInvocations.map((entry) => [entry.invocationKey, entry]),
  );

  const projectOutput = (
    output: unknown,
  ): {
    readonly output: unknown;
    readonly result?: WorkflowCallResultReferenceV1;
  } => {
    if (!isRecord(output) || output.kind !== 'workflow_call') return { output };
    assertExactKeys(output, ['kind', 'invocationKey', 'childRunId']);
    assertCheckpoint(
      typeof output.invocationKey === 'string',
      'call result invocation identity is invalid',
    );
    const childRunId = canonicalUuid(
      output.childRunId,
      'call result child run',
    );
    const call = callsByKey.get(output.invocationKey);
    const origin = rawByKey.get(output.invocationKey);
    assertCheckpoint(
      call?.status === 'settled' &&
        call.childStatus === 'succeeded' &&
        call.childRunId === childRunId &&
        origin?.nodeId === call.nodeId &&
        origin.status === 'succeeded',
      'call result requires a successful settled origin',
    );
    return {
      output: { kind: 'inline', attemptId: call.declarationAttemptId },
      result: {
        kind: 'workflow_call',
        invocationKey: output.invocationKey,
        childRunId,
      },
    };
  };
  const projectedInvocations = rawInvocations.map((entry) => {
    const { output, result } = projectOutput(entry.output);
    if (result !== undefined) {
      assertCheckpoint(
        typeof entry.invocationKey === 'string',
        'invocation key is invalid',
      );
      originalOutputs.set(entry.invocationKey, result);
    }
    const call =
      typeof entry.invocationKey === 'string'
        ? callsByKey.get(entry.invocationKey)
        : undefined;
    const waitingCall =
      call?.status === 'awaiting_admission' || call?.status === 'admitted';
    // Internal validation projection only: V2 does not understand dedicated Call waits.
    return {
      ...entry,
      ...(entry.output === undefined ? {} : { output }),
      status:
        waitingCall && entry.status === 'waiting' ? 'running' : entry.status,
    };
  });
  const projectedJoins = source.joins.map((entry) => {
    assertCheckpoint(
      isRecord(entry) && Array.isArray(entry.ledger),
      'join ledger is invalid',
    );
    const identity = entry.joinInvocationKey ?? entry.joinId;
    assertCheckpoint(typeof identity === 'string', 'join identity is invalid');
    const originals = new Map<string, WorkflowCallResultReferenceV1>();
    const ledger = entry.ledger.map((branch) => {
      assertCheckpoint(isRecord(branch), 'join branch is invalid');
      const { output, result } = projectOutput(branch.output);
      if (result !== undefined) {
        assertCheckpoint(
          typeof branch.branchId === 'string',
          'join branch identity is invalid',
        );
        originals.set(branch.branchId, result);
      }
      return { ...branch, ...(branch.output === undefined ? {} : { output }) };
    });
    ledgerOutputs.set(identity, originals);
    return { ...entry, ledger };
  });
  const { calls: _calls, ...ordinary } = source;
  const parsed = parseCheckpointV2Boundary({
    ...ordinary,
    schemaVersion: 2,
    invocations: projectedInvocations,
    joins: projectedJoins,
  });
  const invocations = parsed.invocations
    .map((entry) => {
      const call = callsByKey.get(entry.invocationKey);
      const waitingCall =
        call?.status === 'awaiting_admission' || call?.status === 'admitted';
      const output = originalOutputs.get(entry.invocationKey);
      return {
        ...entry,
        ...(waitingCall ? { status: 'waiting' as const } : {}),
        ...(output === undefined ? {} : { output }),
      };
    })
    .sort((a, b) => compareOrdinal(a.invocationKey, b.invocationKey));
  const invocationByKey = new Map(
    invocations.map((entry) => [entry.invocationKey, entry]),
  );
  for (const call of calls) {
    const entry = invocationByKey.get(call.invocationKey);
    const raw = rawByKey.get(call.invocationKey);
    assertCallInvocation(call, entry, raw, parsed);
  }
  if (!['queued', 'running', 'waiting'].includes(parsed.runStatus))
    assertCheckpoint(
      !calls.some(
        (call) =>
          call.status === 'awaiting_admission' || call.status === 'admitted',
      ),
      'terminal checkpoint cannot have unsettled calls',
    );
  const joins = parsed.joins.map((join) => ({
    ...join,
    ledger: join.ledger.map((branch) => {
      const output = ledgerOutputs
        .get(join.joinInvocationKey ?? join.joinId)
        ?.get(branch.branchId);
      return { ...branch, ...(output === undefined ? {} : { output }) };
    }),
  }));
  return { ...parsed, schemaVersion: 3, invocations, joins, calls };
}

/** Validates wire state only; this does not admit or execute child workflows. */
export function parseWorkflowCheckpointV3(
  value: unknown,
): WorkflowCheckpointV3 {
  try {
    return parseBoundary(value);
  } catch (error) {
    if (error instanceof WorkflowEngineError) throw error;
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      'checkpoint parsing failed',
    );
  }
}

/** Standalone declaration fact boundary; checkpoint cross-relations are separate. */
export function parseWorkflowCallStateV1(value: unknown): WorkflowCallStateV1 {
  try {
    assertBoundedCheckpointJson(value);
    return parseCall(snapshot(value));
  } catch (error) {
    if (error instanceof WorkflowEngineError) throw error;
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      'call state parsing failed',
    );
  }
}
