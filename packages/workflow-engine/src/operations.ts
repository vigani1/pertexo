import {
  NodeExecutionAbortedError,
  type JsonValue as NodeJsonValue,
  type NodeExecutionRequest,
  type NodeExecutionResult,
} from '@pertexo/node-sdk/server';
import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import {
  resolveValueSource,
  type ValueResolution,
} from '@pertexo/workflow-model/mapping';

import {
  advanceWorkflowFromSchedulerState,
  type WorkflowObservation,
} from './advance-workflow.js';
import { WorkflowEngineError } from './errors.js';
import {
  assertAuthenticExecutableIdentity,
  normalizeBoundedEngineJson,
  type CompiledWorkflowExecutableV2,
} from './executable-workflow.js';
import { parseCheckpoint } from './checkpoint.js';
import type { SchedulerState } from './graph-scheduler.js';
import { invocationKey as createInvocationKey } from './scheduling.js';
import type { WorkflowTransitionPlan } from './types.js';

function operationError(
  code:
    | 'observation_invalid'
    | 'attempt_invalid'
    | 'attempt_aborted'
    | 'workflow_identity_invalid',
  message: string,
): never {
  throw new WorkflowEngineError(code, message);
}

function record(
  value: JsonValue,
  code: 'observation_invalid' | 'attempt_invalid',
  label: string,
): Readonly<Record<string, JsonValue>> {
  if (!isJsonRecord(value)) operationError(code, `${label} must be an object`);
  return value;
}

function isJsonRecord(
  value: JsonValue,
): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, JsonValue>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  )
    operationError('observation_invalid', 'observation fields are invalid');
}

type OutcomeStatus = Extract<
  WorkflowObservation,
  { readonly kind: 'outcome' }
>['status'];

function isOutcomeStatus(value: unknown): value is OutcomeStatus {
  return (
    typeof value === 'string' &&
    [
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown',
      'skipped',
    ].some((candidate) => candidate === value)
  );
}

function parseObservations(value: unknown): readonly WorkflowObservation[] {
  let normalized: JsonValue;
  try {
    normalized = normalizeBoundedEngineJson(value ?? []);
  } catch (error) {
    operationError(
      'observation_invalid',
      error instanceof Error ? error.message : 'observations are invalid',
    );
  }
  if (!Array.isArray(normalized))
    operationError('observation_invalid', 'observations must be an array');
  const items = normalized as readonly JsonValue[];
  return items.map((item): WorkflowObservation => {
    const observation = record(item, 'observation_invalid', 'observation');
    if (observation.kind === 'cancel_requested') {
      exactKeys(observation, ['kind']);
      return { kind: 'cancel_requested' };
    }
    if (observation.kind !== 'outcome')
      operationError(
        'observation_invalid',
        'observation kind is unsupported in Phase 3',
      );
    exactKeys(
      observation,
      ['kind', 'invocationKey', 'status'],
      ['output', 'reasonCode'],
    );
    if (
      typeof observation.invocationKey !== 'string' ||
      !isOutcomeStatus(observation.status)
    )
      operationError('observation_invalid', 'outcome observation is invalid');
    let output:
      | { readonly kind: 'inline' | 'artifact'; readonly reference: string }
      | undefined;
    if (observation.output !== undefined) {
      const candidate = record(
        observation.output,
        'observation_invalid',
        'output reference',
      );
      exactKeys(candidate, ['kind', 'reference']);
      if (
        (candidate.kind !== 'inline' && candidate.kind !== 'artifact') ||
        typeof candidate.reference !== 'string' ||
        candidate.reference.length === 0
      )
        operationError('observation_invalid', 'output reference is invalid');
      output = { kind: candidate.kind, reference: candidate.reference };
    }
    if (
      observation.reasonCode !== undefined &&
      typeof observation.reasonCode !== 'string'
    )
      operationError('observation_invalid', 'reasonCode is invalid');
    return {
      kind: 'outcome',
      invocationKey: observation.invocationKey,
      status: observation.status,
      ...(output === undefined ? {} : { output }),
      ...(observation.reasonCode === undefined
        ? {}
        : { reasonCode: observation.reasonCode }),
    };
  });
}

export interface AdvanceWorkflowInput {
  readonly runId: string;
  readonly executable: CompiledWorkflowExecutableV2;
  readonly workflowVersionId: string;
  readonly checkpoint: unknown;
  readonly observations?: unknown;
  readonly occurredAt: string;
  readonly maximumAdmissions: number;
  readonly signal: AbortSignal;
}

function assertIdentity(
  value: string,
  label: string,
  code: 'attempt_invalid' | 'workflow_identity_invalid',
): void {
  if (value.length === 0 || value.length > 256)
    operationError(code, `${label} is invalid`);
}

function schedulerState(
  executable: CompiledWorkflowExecutableV2,
): SchedulerState {
  return {
    nodes: executable.envelope.graph.nodes.map(({ id, disabled }) => ({
      id,
      disabled,
    })),
    edges: executable.envelope.graph.edges.map(({ source, target }) => ({
      source: { nodeId: source.nodeId },
      target: { nodeId: target.nodeId },
    })),
  };
}

function assertCheckpointMatchesExecutable(
  checkpoint: ReturnType<typeof parseCheckpoint>,
  executable: CompiledWorkflowExecutableV2,
): void {
  if (checkpoint.joins.length !== 0 || checkpoint.loops.length !== 0)
    operationError(
      'workflow_identity_invalid',
      'checkpoint contains unsupported coordinator state',
    );
  const nodeIds = new Set(executable.envelope.graph.nodes.map(({ id }) => id));
  const invocationKeys = new Set<string>();
  for (const invocation of checkpoint.invocations) {
    if (
      !nodeIds.has(invocation.nodeId) ||
      invocation.invocationKey !==
        createInvocationKey({
          workflowVersionId: checkpoint.workflowVersionId,
          nodeId: invocation.nodeId,
        })
    )
      operationError(
        'workflow_identity_invalid',
        'checkpoint invocation does not belong to the executable graph',
      );
    invocationKeys.add(invocation.invocationKey);
  }
  if (
    checkpoint.admittedInvocationKeys.some(
      (invocationKey) => !invocationKeys.has(invocationKey),
    )
  )
    operationError(
      'workflow_identity_invalid',
      'checkpoint admission does not belong to an executable invocation',
    );
}

export async function advanceWorkflow(
  input: AdvanceWorkflowInput,
): Promise<WorkflowTransitionPlan> {
  assertAuthenticExecutableIdentity(input.executable);
  assertIdentity(input.runId, 'runId', 'workflow_identity_invalid');
  assertIdentity(
    input.workflowVersionId,
    'workflowVersionId',
    'workflow_identity_invalid',
  );
  await Promise.resolve();
  assertNotAborted(input.signal);
  const checkpoint = parseCheckpoint(input.checkpoint);
  if (checkpoint.workflowVersionId !== input.workflowVersionId)
    operationError(
      'workflow_identity_invalid',
      'checkpoint workflow version does not match executable identity',
    );
  assertCheckpointMatchesExecutable(checkpoint, input.executable);
  const plan = advanceWorkflowFromSchedulerState({
    checkpoint,
    schedulerState: schedulerState(input.executable),
    observations: parseObservations(input.observations),
    occurredAt: input.occurredAt,
    maximumAdmissions: input.maximumAdmissions,
  });
  assertNotAborted(input.signal);
  return plan;
}

export interface NodeExecutionRegistry {
  readonly execute: (
    request: NodeExecutionRequest,
  ) => Promise<NodeExecutionResult>;
}

export interface ExecuteNodeAttemptInput {
  readonly runId: string;
  readonly nodeRunId: string;
  readonly attemptId: string;
  readonly executable: CompiledWorkflowExecutableV2;
  readonly workflowVersionId: string;
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly runInput: unknown;
  readonly completedNodeOutputs: unknown;
  readonly registry: NodeExecutionRegistry;
  readonly signal: AbortSignal;
}

export interface NodeAttemptOutcome {
  readonly runId: string;
  readonly nodeRunId: string;
  readonly attemptId: string;
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly kind: NodeExecutionResult['kind'];
  readonly output: NodeJsonValue;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    operationError('attempt_aborted', 'node attempt was aborted');
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof NodeExecutionAbortedError ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

export async function executeNodeAttempt(
  input: ExecuteNodeAttemptInput,
): Promise<NodeAttemptOutcome> {
  assertAuthenticExecutableIdentity(input.executable);
  assertIdentity(input.runId, 'runId', 'attempt_invalid');
  assertIdentity(input.nodeRunId, 'nodeRunId', 'attempt_invalid');
  assertIdentity(input.attemptId, 'attemptId', 'attempt_invalid');
  assertIdentity(
    input.workflowVersionId,
    'workflowVersionId',
    'attempt_invalid',
  );
  assertNotAborted(input.signal);
  let runInput: JsonValue;
  let completed: JsonValue;
  try {
    runInput = normalizeBoundedEngineJson(input.runInput);
    completed = normalizeBoundedEngineJson(input.completedNodeOutputs);
  } catch (error) {
    operationError(
      'attempt_invalid',
      error instanceof Error ? error.message : 'attempt input is invalid',
    );
  }
  const completedOutputs = record(
    completed,
    'attempt_invalid',
    'completed outputs',
  );
  const node = input.executable.envelope.graph.nodes.find(
    ({ id }) => id === input.nodeId,
  );
  if (node === undefined || node.disabled)
    operationError('attempt_invalid', 'node is not executable');
  if (
    input.invocationKey !==
    createInvocationKey({
      workflowVersionId: input.workflowVersionId,
      nodeId: node.id,
    })
  )
    operationError(
      'attempt_invalid',
      'node invocation identity does not match',
    );
  const directUpstream = new Set(
    input.executable.envelope.graph.edges
      .filter(({ target }) => target.nodeId === node.id)
      .map(({ source }) => source.nodeId),
  );
  if (Object.keys(completedOutputs).some((key) => !directUpstream.has(key)))
    operationError(
      'attempt_invalid',
      'completed output is not direct upstream',
    );
  let resolvedInput: JsonValue;
  if (node.definition.key === 'core.manual' && node.definition.version === 1)
    resolvedInput = runInput;
  else {
    const mapped: Record<string, JsonValue> = {};
    for (const key of Object.keys(node.inputMappings).sort()) {
      assertNotAborted(input.signal);
      const source = node.inputMappings[key];
      if (source === undefined) continue;
      if (
        source.kind === 'node_output' &&
        (!directUpstream.has(source.nodeId) ||
          !Object.hasOwn(completedOutputs, source.nodeId))
      )
        operationError(
          'attempt_invalid',
          'mapping upstream output is incomplete',
        );
      let resolution: ValueResolution;
      try {
        resolution = await resolveValueSource(
          source,
          { runInput, nodeOutputs: completedOutputs },
          undefined,
          input.signal,
        );
      } catch (error) {
        if (input.signal.aborted || isAbortError(error))
          operationError('attempt_aborted', 'node attempt was aborted');
        operationError('attempt_invalid', 'mapping failed');
      }
      if (
        resolution.kind === 'error' &&
        (resolution.expression?.code === 'canceled' || input.signal.aborted)
      )
        operationError('attempt_aborted', 'node attempt was aborted');
      if (resolution.kind === 'error')
        operationError('attempt_invalid', 'mapping resolution failed');
      if (resolution.kind === 'value') mapped[key] = resolution.value;
    }
    try {
      resolvedInput = normalizeBoundedEngineJson(mapped);
    } catch {
      operationError('attempt_invalid', 'mapped input exceeds runtime limits');
    }
  }
  assertNotAborted(input.signal);
  let result: NodeExecutionResult;
  try {
    result = await input.registry.execute({
      definition: node.definition,
      executor: node.executor,
      config: node.config,
      input: resolvedInput,
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted || isAbortError(error))
      operationError('attempt_aborted', 'node attempt was aborted');
    operationError('attempt_invalid', 'node execution failed');
  }
  return {
    runId: input.runId,
    nodeRunId: input.nodeRunId,
    attemptId: input.attemptId,
    invocationKey: input.invocationKey,
    nodeId: node.id,
    kind: result.kind,
    output: result.output,
  };
}
