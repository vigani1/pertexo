import { createHash } from 'node:crypto';
import { canonicalJson } from '@pertexo/workflow-model/canonical-json';
import type { WorkflowCallableDeclarationV1 } from '@pertexo/workflow-model/callable-graph-contract';
import {
  WORKFLOW_CALL_FAMILY_POLICY_V1,
  workflowCallPinSchemaV1,
} from '@pertexo/workflow-model/workflow-call-contract';
import {
  assertAuthenticExecutableIdentityV3,
  type CompiledWorkflowExecutableV3,
} from './executable-workflow.js';
import { findExecutableNodeContext } from './compilation/executable-graph.js';
import { WorkflowEngineError } from './errors.js';
import { compareOrdinal } from './ordering.js';
import type { OutputReference } from './types.js';
import type {
  WorkflowCallInvocationStateV1,
  WorkflowCallStateV1,
  WorkflowCheckpointV3,
} from './workflow-call-state.js';
import {
  parseWorkflowCallStateV1,
  parseWorkflowCheckpointV3,
} from './checkpoint/checkpoint-v3.js';
import { validateWorkflowCallInputV1 } from './workflow-call-values.js';

/** Material already reconciled against its immutable succeeded physical attempt. */
export interface WorkflowCallDeclarationMaterialV1 {
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly declarationAttemptId: string;
  readonly input: OutputReference;
  readonly value: unknown;
}

export interface WorkflowCallControlDecisionV1 {
  readonly call: WorkflowCallStateV1;
  readonly invocation: WorkflowCallInvocationStateV1;
  /** Persist immutable declaration identity, including a zero-child control abort. */
  readonly declarationIntent: boolean;
  readonly admissionIntent: boolean;
  readonly cancelChild?: Readonly<{
    readonly childRunId: string;
    readonly reason: 'cancel_requested' | 'deadline_expired';
  }>;
  readonly reasonCode?: string;
}

function invalid(message: string): never {
  throw new WorkflowEngineError('observation_invalid', message);
}

function declarationIdentity(call: WorkflowCallStateV1): string {
  return canonicalJson({
    invocationKey: call.invocationKey,
    nodeId: call.nodeId,
    declarationAttemptId: call.declarationAttemptId,
    input: call.input,
    inputChecksum: call.inputChecksum,
    pin: call.pin,
  });
}

function applyCallFact(
  current: WorkflowCallStateV1,
  fact: WorkflowCallStateV1,
): WorkflowCallStateV1 {
  if (declarationIdentity(current) !== declarationIdentity(fact))
    invalid('durable call identity does not match its declaration');
  if (fact.status === 'awaiting_admission')
    invalid('durable call admission has no definite outcome');
  if (current.status === 'awaiting_admission') return fact;
  if (current.status === 'admitted') {
    if (
      (fact.status !== 'admitted' && fact.status !== 'settled') ||
      fact.childRunId !== current.childRunId
    )
      invalid('durable call changed its admitted child');
    return fact;
  }
  if (canonicalJson(current) !== canonicalJson(fact))
    invalid('durable call changed its terminal outcome');
  return current;
}

function stoppedStatus(input: {
  readonly cancelRequested: boolean;
  readonly deadlineExpired: boolean;
}): 'canceled' | 'timed_out' | undefined {
  return input.cancelRequested
    ? 'canceled'
    : input.deadlineExpired
      ? 'timed_out'
      : undefined;
}

function invocationForCall(
  call: WorkflowCallStateV1,
  previous: WorkflowCallInvocationStateV1,
  stop: ReturnType<typeof stoppedStatus>,
): WorkflowCallInvocationStateV1 {
  // Once the control settled, later cancellation cannot rewrite it.
  if (!['running', 'waiting'].includes(previous.status)) return previous;
  const {
    output: _output,
    resumeAt: _resumeAt,
    waitKind: _waitKind,
    ...base
  } = previous;
  if (call.status === 'awaiting_admission' || call.status === 'admitted')
    return { ...base, status: 'waiting' };
  if (call.status === 'aborted')
    return {
      ...base,
      status:
        call.reasonCode === 'workflow.canceled' ? 'canceled' : 'timed_out',
    };
  if (call.status === 'refused') return { ...base, status: stop ?? 'failed' };
  if (call.childStatus === 'outcome_unknown')
    return { ...base, status: 'outcome_unknown' };
  if (stop !== undefined) return { ...base, status: stop };
  if (call.childStatus !== 'succeeded') return { ...base, status: 'failed' };
  return {
    ...base,
    status: 'succeeded',
    output: {
      kind: 'workflow_call',
      invocationKey: call.invocationKey,
      childRunId: call.childRunId,
    },
  };
}

function reasonForCall(call: WorkflowCallStateV1): string | undefined {
  if (call.status === 'refused' || call.status === 'aborted')
    return call.reasonCode;
  if (call.status !== 'settled' || call.childStatus === 'succeeded')
    return undefined;
  return `workflow.child_${call.childStatus}`;
}

/**
 * Pure control derivation at the established coordinator seam. Declaration
 * materials are internal physical projections, not a raw JSON parser. Admission
 * facts are immutable journal/child-terminal projections; policy checks and
 * child insertion stay with the atomic database commit owner.
 */
export function deriveWorkflowCallControlsV1(input: {
  readonly executable: CompiledWorkflowExecutableV3;
  readonly checkpoint: unknown;
  readonly declarations: readonly WorkflowCallDeclarationMaterialV1[];
  readonly facts: readonly unknown[];
  readonly calleeDeclarations: ReadonlyMap<
    string,
    WorkflowCallableDeclarationV1
  >;
  readonly cancelRequested: boolean;
  readonly deadlineExpired: boolean;
}): readonly WorkflowCallControlDecisionV1[] {
  assertAuthenticExecutableIdentityV3(input.executable);
  if (
    input.declarations.length > WORKFLOW_CALL_FAMILY_POLICY_V1.maxChildRuns ||
    input.facts.length > WORKFLOW_CALL_FAMILY_POLICY_V1.maxChildRuns
  )
    invalid('call control projection exceeds the family declaration bound');
  const checkpoint = parseWorkflowCheckpointV3(input.checkpoint);
  const controls = {
    cancelRequested: checkpoint.cancelRequested || input.cancelRequested,
    deadlineExpired: checkpoint.deadlineExpired || input.deadlineExpired,
  };
  const stop = stoppedStatus(controls);
  const calls = new Map(
    checkpoint.calls.map((call) => [call.invocationKey, call]),
  );
  const invocations = new Map(
    checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const declared = new Set<string>();
  for (const call of checkpoint.calls) {
    const node = findExecutableNodeContext(
      input.executable.envelope.graph,
      call.nodeId,
    )?.node;
    if (
      node?.definition.key !== 'core.workflow_call' ||
      node.definition.version !== 1 ||
      canonicalJson(workflowCallPinSchemaV1.parse(node.config)) !==
        canonicalJson(call.pin)
    )
      invalid('retained call does not match its executable pin');
  }
  for (const material of input.declarations) {
    const invocation = invocations.get(material.invocationKey);
    const node = findExecutableNodeContext(
      input.executable.envelope.graph,
      material.nodeId,
    )?.node;
    if (
      invocation?.nodeId !== material.nodeId ||
      invocation.attemptNumber !== 1 ||
      node?.definition.key !== 'core.workflow_call' ||
      node.definition.version !== 1
    )
      invalid('call declaration does not belong to its executable invocation');
    const pin = workflowCallPinSchemaV1.parse(node.config);
    const declaration = input.calleeDeclarations.get(pin.versionId);
    if (declaration === undefined)
      invalid('retained callee declaration is missing');
    const validated = validateWorkflowCallInputV1({
      pin,
      declaration,
      value: material.value,
    });
    if (!validated.ok)
      invalid('succeeded call declaration contains invalid input');
    const call = parseWorkflowCallStateV1({
      invocationKey: material.invocationKey,
      nodeId: material.nodeId,
      declarationAttemptId: material.declarationAttemptId,
      pin,
      input: material.input,
      inputChecksum: createHash('sha256')
        .update(canonicalJson(validated.value))
        .digest('hex'),
      status: stop === undefined ? 'awaiting_admission' : 'aborted',
      ...(stop === undefined ? {} : { reasonCode: `workflow.${stop}` }),
    });
    const previous = calls.get(call.invocationKey);
    if (previous !== undefined) {
      if (declarationIdentity(previous) !== declarationIdentity(call))
        invalid('replayed call declaration changed immutable input or pins');
    } else {
      if (invocation.status !== 'running')
        invalid('new call declaration requires its running first attempt');
      calls.set(call.invocationKey, call);
      declared.add(call.invocationKey);
    }
  }
  const seenFacts = new Set<string>();
  for (const value of input.facts) {
    const fact = parseWorkflowCallStateV1(value);
    const current = calls.get(fact.invocationKey);
    if (current === undefined || declared.has(fact.invocationKey))
      invalid('durable call fact has no committed declaration');
    if (seenFacts.has(fact.invocationKey))
      invalid('durable call facts are duplicated');
    seenFacts.add(fact.invocationKey);
    calls.set(fact.invocationKey, applyCallFact(current, fact));
  }
  const decisions = [...calls.values()]
    .sort((left, right) =>
      compareOrdinal(left.invocationKey, right.invocationKey),
    )
    .map((call): WorkflowCallControlDecisionV1 => {
      const previous = invocations.get(call.invocationKey);
      if (previous === undefined) invalid('call invocation is missing');
      if (
        !declared.has(call.invocationKey) &&
        (call.status === 'awaiting_admission' || call.status === 'admitted') &&
        !seenFacts.has(call.invocationKey)
      )
        invalid('committed call is missing its durable admission fact');
      const invocation = invocationForCall(call, previous, stop);
      const reasonCode = reasonForCall(call);
      return {
        call,
        invocation,
        declarationIntent: declared.has(call.invocationKey),
        admissionIntent:
          declared.has(call.invocationKey) &&
          call.status === 'awaiting_admission',
        ...(call.status !== 'admitted' || stop === undefined
          ? {}
          : {
              cancelChild: {
                childRunId: call.childRunId,
                reason:
                  stop === 'canceled' ? 'cancel_requested' : 'deadline_expired',
              },
            }),
        ...(reasonCode === undefined ? {} : { reasonCode }),
      };
    });
  const updates = new Map(
    decisions.map(({ invocation }) => [invocation.invocationKey, invocation]),
  );
  const proposed: WorkflowCheckpointV3 = {
    ...checkpoint,
    cancelRequested: controls.cancelRequested,
    deadlineExpired: controls.deadlineExpired,
    calls: decisions.map(({ call }) => call),
    invocations: checkpoint.invocations.map(
      (invocation) => updates.get(invocation.invocationKey) ?? invocation,
    ),
  };
  parseWorkflowCheckpointV3(proposed);
  return decisions;
}
