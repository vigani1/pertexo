import {
  canonicalJson,
  isSafeExecutorErrorCode,
  isWorkflowCallDefinition,
  UUID_PATTERN,
  WORKFLOW_GRAPH_LIMITS,
  type JsonValue,
  type WorkflowCallConfig,
} from '@pertexo/workflow-model';
import type {
  WorkflowExecutableGraph,
  ExecutionNode,
} from '../compilation/foundation.js';
import { findExecutableNodeContext } from '../compilation/graph.js';
import { configuredScopedOutputPorts } from '../transition/scheduling/readiness.js';
import { normalizeBoundedEngineJson } from '../compilation/validation.js';
import { exactKeys, operationError, record } from '../operation-values.js';
import type {
  WorkflowCallIntent,
  WorkflowCallOutcome,
  WorkflowCheckpoint,
  WorkflowObservation,
} from '../types.js';
import { completedOutputReference } from './coordinator-output.js';
import { parseBranchPath, parseIterationPath } from '../checkpoint/fields.js';
import { invocationKey } from '../transition/scheduling/loops.js';
import {
  isFinishedIterationScope,
  isTerminalNodeStatus,
} from '../transition/state.js';

/** Executor success prepares input; only the child fact settles the logical Call. */
export function callDeclarationObservations(
  successfulOutcomes: ReadonlyMap<string, Readonly<Record<string, JsonValue>>>,
  checkpoint: WorkflowCheckpoint,
  nodes: ReadonlyMap<string, ExecutionNode>,
): Readonly<{
  intents: readonly WorkflowCallIntent[];
  observations: readonly WorkflowObservation[];
  declarationInvocationKeys: ReadonlySet<string>;
}> {
  const declarations = new Set<string>();
  const intents: WorkflowCallIntent[] = [];
  for (const outcome of successfulOutcomes.values()) {
    const owner = checkpoint.invocations.find(
      ({ invocationKey }) => invocationKey === outcome.invocationKey,
    );
    const node = nodes.get(owner?.nodeId ?? '');
    const notCallable =
      owner === undefined ||
      node === undefined ||
      !isWorkflowCallDefinition(node.definition);
    if (notCallable) continue;
    const input = completedOutputReference(
      outcome,
      outcome.attemptId as string,
    );
    if (input === undefined)
      operationError(
        'observation_invalid',
        'Call declaration input is missing',
      );
    if (declarations.has(owner.invocationKey))
      operationError('observation_invalid', 'Call declaration conflicts');
    declarations.add(owner.invocationKey);
    // Executable compilation validated core.call config; the generic node type
    // cannot express that its definition selects WorkflowCallConfig.
    intents.push({
      invocationKey: owner.invocationKey,
      target: (node.config as unknown as WorkflowCallConfig).target,
      input,
    });
  }
  return {
    intents,
    declarationInvocationKeys: declarations,
    observations: intents.map(({ invocationKey }) => ({
      kind: 'call_started',
      invocationKey,
      coordinatorDerived: true,
    })),
  };
}

function parseCallOutcome(value: JsonValue): WorkflowCallOutcome {
  const fact = record(value, 'observation_invalid', 'Call outcome');
  const { callId, invocationKey, nodeId, reasonCode } = fact;

  exactKeys(
    fact,
    ['callId', 'invocationKey', 'nodeId', 'status'],
    ['reasonCode', 'branchPath', 'iterationPath'],
  );
  const invalidCallIdentity =
    typeof callId !== 'string' ||
    !UUID_PATTERN.test(callId) ||
    typeof invocationKey !== 'string' ||
    invocationKey.length === 0 ||
    invocationKey.length > 256 ||
    typeof nodeId !== 'string' ||
    nodeId.length === 0 ||
    typeof fact.status !== 'string' ||
    ![
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown',
      'refused',
    ].includes(fact.status) ||
    (reasonCode !== undefined && !isSafeExecutorErrorCode(reasonCode));
  if (invalidCallIdentity)
    operationError('observation_invalid', 'Call outcome identity is invalid');
  const branchPath = parseBranchPath(fact.branchPath, 'invocation');
  const iterationPath = parseIterationPath(fact.iterationPath, 'invocation');
  return {
    callId: callId,
    invocationKey: invocationKey,
    nodeId: nodeId,
    status: fact.status as WorkflowCallOutcome['status'],
    branchPath,
    iterationPath,
    ...(reasonCode === undefined ? {} : { reasonCode: reasonCode }),
  };
}

/** Call facts are immutable relations, not additions to the parent's event cursor. */
export function callOutcomeObservations(
  input: unknown,
  checkpoint: WorkflowCheckpoint,
  nodes: ReadonlyMap<string, ExecutionNode>,
  graph: WorkflowExecutableGraph,
): readonly WorkflowObservation[] {
  let bounded: JsonValue;
  try {
    bounded = normalizeBoundedEngineJson(input ?? []);
  } catch {
    operationError('observation_invalid', 'Call outcomes are invalid');
  }
  if (
    !Array.isArray(bounded) ||
    bounded.length > WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations
  )
    operationError('observation_invalid', 'Call outcome window is invalid');
  const seen = new Map<string, string>();
  const observations: WorkflowObservation[] = [];
  for (const value of bounded as readonly JsonValue[]) {
    const fact = parseCallOutcome(value);
    const canonical = canonicalJson(fact);
    const previous = seen.get(fact.invocationKey);
    if (previous !== undefined) {
      if (previous !== canonical)
        operationError('observation_invalid', 'Call outcomes conflict');
      continue;
    }
    seen.set(fact.invocationKey, canonical);
    assertCallOutcomeScope(fact, { checkpoint, nodes, graph });
    const owner = checkpoint.invocations.find(
      ({ invocationKey }) => invocationKey === fact.invocationKey,
    );
    if (owner === undefined) {
      if (isFinishedIterationScope(checkpoint.loops, fact)) continue;
      operationError(
        'observation_invalid',
        'Call outcome invocation is unknown',
      );
    }
    if (isTerminalNodeStatus(owner.status)) {
      if (owner.output?.kind === 'call' && owner.output.callId !== fact.callId)
        operationError('observation_invalid', 'Call result identity conflicts');
      continue;
    }
    if (owner.status !== 'waiting' || owner.waitKind !== 'workflow_call')
      operationError('observation_invalid', 'Call outcome has no durable wait');
    observations.push({
      kind: 'outcome',
      invocationKey: fact.invocationKey,
      status: callOutcomeStatus(fact.status),
      ...(fact.status === 'succeeded'
        ? { output: { kind: 'call', callId: fact.callId } as const }
        : { reasonCode: fact.reasonCode ?? `call_child_${fact.status}` }),
      coordinatorDerived: true,
    });
  }
  return observations;
}

function assertCallOutcomeScope(
  fact: WorkflowCallOutcome,
  {
    checkpoint,
    nodes,
    graph,
  }: Readonly<{
    checkpoint: WorkflowCheckpoint;
    nodes: ReadonlyMap<string, ExecutionNode>;
    graph: WorkflowExecutableGraph;
  }>,
): void {
  const expectedKey = invocationKey({
    workflowVersionId: checkpoint.workflowVersionId,
    nodeId: fact.nodeId,
    branchPath: (fact.branchPath ?? []).map(
      ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
    ),
    iterationPath: fact.iterationPath ?? [],
  });
  const context = findExecutableNodeContext(graph, fact.nodeId);
  const invalidCallScope =
    context?.ancestors.length !== (fact.iterationPath?.length ?? 0) ||
    context.ancestors.some(
      (loopNodeId, index) =>
        fact.iterationPath?.[index]?.loopNodeId !== loopNodeId,
    ) ||
    (fact.branchPath ?? []).some(({ nodeId, outputPort }) => {
      const node = nodes.get(nodeId);
      return (
        node === undefined ||
        !configuredScopedOutputPorts(node)?.includes(outputPort)
      );
    }) ||
    expectedKey !== fact.invocationKey ||
    !isWorkflowCallDefinition(nodes.get(fact.nodeId)?.definition);
  if (invalidCallScope)
    operationError('observation_invalid', 'Call outcome scope is invalid');
}
function callOutcomeStatus(
  status: WorkflowCallOutcome['status'],
): 'succeeded' | 'outcome_unknown' | 'failed' {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'outcome_unknown') return 'outcome_unknown';
  return 'failed';
}
