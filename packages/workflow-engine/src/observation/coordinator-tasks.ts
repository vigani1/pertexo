import {
  canonicalJson,
  isHumanTaskDefinition,
  UUID_PATTERN,
  WORKFLOW_GRAPH_LIMITS,
  type JsonValue,
  type ApprovalConfig,
} from '@pertexo/workflow-model';
import type {
  WorkflowExecutableGraph,
  WorkflowExecutableNode,
} from '../compilation/foundation.js';
import { findExecutableNodeContext } from '../compilation/graph.js';
import { normalizeBoundedEngineJson } from '../compilation/validation.js';
import { exactKeys, operationError, record } from '../operation-values.js';
import { parseBranchPath, parseIterationPath } from '../checkpoint/fields.js';
import { configuredScopedOutputPorts } from '../transition/scheduling/readiness.js';
import { invocationKey } from '../transition/scheduling/loops.js';
import {
  isFinishedIterationScope,
  isTerminalNodeStatus,
} from '../transition/state.js';
import type {
  InvocationState,
  PendingTaskIntent,
  PendingTaskOutcome,
  WorkflowCheckpoint,
  WorkflowObservation,
} from '../types.js';

/** A successful declaration opens a task; it cannot choose a decision path. */
export function taskDeclarationObservations(
  completedItems: readonly JsonValue[],
  successfulOutcomes: ReadonlyMap<string, Readonly<Record<string, JsonValue>>>,
  invocations: ReadonlyMap<string, InvocationState>,
  nodes: ReadonlyMap<string, WorkflowExecutableNode>,
): Readonly<{
  intents: readonly PendingTaskIntent[];
  observations: readonly WorkflowObservation[];
  declarationInvocationKeys: ReadonlySet<string>;
}> {
  const declarations = new Set<string>();
  const intents: PendingTaskIntent[] = [];
  const pending = new Set<string>();
  for (const item of completedItems) {
    const material = item as Readonly<{
      sequence: number;
      attemptId: string;
      invocationKey: string;
      value: JsonValue;
    }>;
    const owner = invocations.get(material.invocationKey);
    if (!isHumanTaskDefinition(nodes.get(owner?.nodeId ?? '')?.definition))
      continue;
    const value = record(
      material.value,
      'observation_invalid',
      'task declaration output',
    );
    exactKeys(value, ['pending']);
    if (value.pending !== true)
      operationError('observation_invalid', 'task declaration is not pending');
    pending.add(
      `${String(material.sequence)}\u0000${material.attemptId}\u0000${material.invocationKey}`,
    );
  }
  for (const [identity, outcome] of successfulOutcomes) {
    const owner =
      typeof outcome.invocationKey === 'string'
        ? invocations.get(outcome.invocationKey)
        : undefined;
    const node = nodes.get(owner?.nodeId ?? '');
    if (
      owner === undefined ||
      node === undefined ||
      !isHumanTaskDefinition(node.definition)
    )
      continue;
    if (!pending.has(identity) || declarations.has(owner.invocationKey))
      operationError(
        'observation_invalid',
        'task declaration evidence is missing or conflicting',
      );
    declarations.add(owner.invocationKey);
    intents.push({
      invocationKey: owner.invocationKey,
      config: node.config as unknown as ApprovalConfig,
    });
  }
  return {
    intents,
    declarationInvocationKeys: declarations,
    observations: intents.map(({ invocationKey }) => ({
      kind: 'task_started',
      invocationKey,
      coordinatorDerived: true,
    })),
  };
}

function parseTaskOutcome(value: JsonValue): PendingTaskOutcome {
  const fact = record(value, 'observation_invalid', 'task outcome');
  exactKeys(
    fact,
    ['taskId', 'invocationKey', 'nodeId', 'status'],
    ['branchPath', 'iterationPath'],
  );
  if (
    typeof fact.taskId !== 'string' ||
    !UUID_PATTERN.test(fact.taskId) ||
    typeof fact.invocationKey !== 'string' ||
    fact.invocationKey.length === 0 ||
    fact.invocationKey.length > 256 ||
    typeof fact.nodeId !== 'string' ||
    fact.nodeId.length === 0 ||
    typeof fact.status !== 'string' ||
    !['approved', 'rejected', 'expired', 'refused', 'canceled'].includes(
      fact.status,
    )
  )
    operationError('observation_invalid', 'task outcome identity is invalid');
  return {
    taskId: fact.taskId,
    invocationKey: fact.invocationKey,
    nodeId: fact.nodeId,
    status: fact.status as PendingTaskOutcome['status'],
    branchPath: parseBranchPath(fact.branchPath, 'invocation'),
    iterationPath: parseIterationPath(fact.iterationPath, 'invocation'),
  };
}

/** Typed stored task facts settle only their exact waiting invocation. */
export function taskOutcomeObservations(
  input: unknown,
  checkpoint: WorkflowCheckpoint,
  nodes: ReadonlyMap<string, WorkflowExecutableNode>,
  graph: WorkflowExecutableGraph,
): readonly WorkflowObservation[] {
  let bounded: JsonValue;
  try {
    bounded = normalizeBoundedEngineJson(input ?? []);
  } catch {
    operationError('observation_invalid', 'task outcomes are invalid');
  }
  if (
    !Array.isArray(bounded) ||
    bounded.length > WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations
  )
    operationError('observation_invalid', 'task outcome window is invalid');
  const seen = new Map<string, string>();
  const invocations = new Map(
    checkpoint.invocations.map((owner) => [owner.invocationKey, owner]),
  );
  const observations: WorkflowObservation[] = [];
  for (const item of bounded as readonly JsonValue[]) {
    const fact = parseTaskOutcome(item);
    const canonical = canonicalJson(fact);
    const previous = seen.get(fact.invocationKey);
    if (previous !== undefined) {
      if (previous !== canonical)
        operationError('observation_invalid', 'task outcomes conflict');
      continue;
    }
    seen.set(fact.invocationKey, canonical);
    const context = findExecutableNodeContext(graph, fact.nodeId);
    const expected = invocationKey({
      workflowVersionId: checkpoint.workflowVersionId,
      nodeId: fact.nodeId,
      branchPath: (fact.branchPath ?? []).map(
        ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
      ),
      iterationPath: fact.iterationPath ?? [],
    });
    if (
      !isHumanTaskDefinition(nodes.get(fact.nodeId)?.definition) ||
      expected !== fact.invocationKey ||
      context?.ancestors.length !== (fact.iterationPath?.length ?? 0) ||
      context.ancestors.some(
        (id, index) => fact.iterationPath?.[index]?.loopNodeId !== id,
      ) ||
      (fact.branchPath ?? []).some(
        ({ nodeId, outputPort }) =>
          !configuredScopedOutputPorts(nodes.get(nodeId) ?? {})?.includes(
            outputPort,
          ),
      )
    )
      operationError('observation_invalid', 'task outcome scope is invalid');
    const owner = invocations.get(fact.invocationKey);
    if (owner === undefined) {
      if (isFinishedIterationScope(checkpoint.loops, fact)) continue;
      operationError(
        'observation_invalid',
        'task outcome invocation is unknown',
      );
    }
    if (isTerminalNodeStatus(owner.status)) {
      if (owner.output?.kind === 'task' && owner.output.taskId !== fact.taskId)
        operationError('observation_invalid', 'task result identity conflicts');
      continue;
    }
    if (owner.status !== 'waiting' || owner.waitKind !== 'human_task')
      operationError('observation_invalid', 'task outcome has no durable wait');
    const decided = fact.status === 'approved' || fact.status === 'rejected';
    const reasonCode =
      fact.status === 'refused'
        ? 'pending_task.capacity_exceeded'
        : 'pending_task.expired';
    observations.push({
      kind: 'outcome',
      invocationKey: fact.invocationKey,
      status: decided
        ? 'succeeded'
        : fact.status === 'canceled'
          ? 'canceled'
          : 'failed',
      ...(decided
        ? { output: { kind: 'task', taskId: fact.taskId } as const }
        : { reasonCode }),
      ...(!decided && fact.status !== 'canceled'
        ? {
            failure: {
              nodeId: fact.nodeId,
              invocationKey: fact.invocationKey,
              attemptNumber: owner.attemptNumber,
              errorKind: 'human_task' as const,
              safeErrorCode: reasonCode,
            },
          }
        : {}),
      coordinatorDerived: true,
    });
    if (decided)
      observations.push({
        kind: 'branch_selected',
        invocationKey: fact.invocationKey,
        nodeId: fact.nodeId,
        selectedOutputPort: fact.status,
        coordinatorDerived: true,
      });
  }
  return observations;
}
