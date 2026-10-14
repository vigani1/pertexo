import {
  canonicalJson,
  inspectWorkflowDecisionTree,
  type WorkflowEdge,
  WORKFLOW_FAILURE_PORT,
} from '@pertexo/workflow-model';
import { assertAuthenticExecutableIdentity } from '../compilation/foundation.js';
import { assertCheckpointMatchesExecutable } from '../checkpoint/matches-executable.js';
import {
  decideRetry,
  resolveRetryPolicy,
  type RetryPolicy,
} from '../attempt/retries.js';
import { invocationKey } from '../transition/scheduling/loops.js';
import type { BranchScopePart } from '../types.js';
import type {
  RecoveryAttempt,
  RecoveryCandidate,
  RecoveryNode,
  RecoveryPrefixNode,
  RecoveryRefused,
  RecoverySource,
} from './contract.js';
import type { CompiledWorkflowExecutable } from '../compilation/foundation.js';

function completeFailure(
  attempt: RecoveryAttempt,
): attempt is RecoveryAttempt & {
  failureKind: 'failed' | 'retry' | 'outcome_unknown';
  errorKind: NonNullable<RecoveryAttempt['errorKind']>;
  possiblyDispatched: boolean;
} {
  return (
    (attempt.status === 'failed' || attempt.status === 'outcome_unknown') &&
    (attempt.failureKind === 'failed' ||
      attempt.failureKind === 'retry' ||
      attempt.failureKind === 'outcome_unknown') &&
    attempt.errorKind !== null &&
    attempt.possiblyDispatched !== null
  );
}

function completeAttempts(node: RecoveryNode): boolean {
  if (
    node.currentAttemptNumber === null ||
    node.currentAttemptNumber < 1 ||
    node.attempts.length !== node.currentAttemptNumber
  )
    return false;
  for (const [index, attempt] of node.attempts.entries()) {
    if (attempt.number !== index + 1) return false;
    if (
      index < node.attempts.length - 1 &&
      (!completeFailure(attempt) ||
        attempt.status !== 'failed' ||
        attempt.retryDecision !== 'retry')
    )
      return false;
  }
  const current = node.attempts.at(-1);
  return (
    current?.id === node.currentAttemptId &&
    (current.status === node.status ||
      (node.status === 'outcome_unknown' && current.status === 'failed'))
  );
}

function retryOutcome(
  node: RecoveryNode,
  attempt: RecoveryAttempt,
  policy: RetryPolicy,
) {
  if (!completeFailure(attempt)) return undefined;
  return decideRetry({
    sideEffectClass: node.sideEffectClass,
    currentAttemptNumber: attempt.number,
    policy,
    observation: {
      kind: 'executor_failure',
      recommendation: attempt.failureKind,
      errorKind: attempt.errorKind,
      possiblyDispatched: attempt.possiblyDispatched,
    },
  });
}

/** Select only the values needed for a single verified root-to-failure path. */
export function selectRecoveryPrefix(
  input: Readonly<{
    executable: CompiledWorkflowExecutable;
    source: RecoverySource;
  }>,
): RecoveryCandidate | RecoveryRefused {
  const { executable, source } = input;
  assertAuthenticExecutableIdentity(executable);
  if (source.status !== 'failed' && source.status !== 'outcome_unknown')
    return { kind: 'refused', reason: 'source_not_failed' };
  const graph = executable.envelope.graph;
  const tree = inspectWorkflowDecisionTree(graph);
  if (
    tree === undefined ||
    graph.edges.some((edge) => edge.source.port === WORKFLOW_FAILURE_PORT)
  )
    return { kind: 'refused', reason: 'unsupported_graph' };
  if (
    source.completedAt === null ||
    source.workflowVersionId !== source.checkpoint.workflowVersionId ||
    source.checkpoint.runStatus !== source.status ||
    source.checkpoint.cancelRequested ||
    source.checkpoint.deadlineExpired ||
    source.checkpoint.joins.length > 0 ||
    source.checkpoint.loops.length > 0
  )
    return { kind: 'refused', reason: 'evidence_unavailable' };
  assertCheckpointMatchesExecutable(source.checkpoint, executable, graph.nodes);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const records = new Map(source.nodes.map((node) => [node.nodeId, node]));
  const invocations = new Map(
    source.checkpoint.invocations.map((invocation) => [
      invocation.nodeId,
      invocation,
    ]),
  );
  if (
    records.size !== source.nodes.length ||
    invocations.size !== source.checkpoint.invocations.length ||
    source.checkpoint.invocations.some(
      (invocation) =>
        invocation.status !== 'skipped' && !records.has(invocation.nodeId),
    )
  )
    return { kind: 'refused', reason: 'evidence_unavailable' };
  const policy = resolveRetryPolicy(executable.envelope.runtimePolicies.retry);
  for (const record of source.nodes) {
    const node = nodes.get(record.nodeId);
    const invocation = invocations.get(record.nodeId);
    if (
      node?.sideEffectClass !== record.sideEffectClass ||
      invocation?.invocationKey !== record.invocationKey ||
      invocation.status !== record.status ||
      invocation.attemptNumber !== (record.currentAttemptNumber ?? 0) ||
      canonicalJson(invocation.branchPath ?? []) !==
        canonicalJson(record.branchPath ?? []) ||
      (record.iterationPath?.length ?? 0) !== 0 ||
      (invocation.iterationPath?.length ?? 0) !== 0
    )
      return { kind: 'refused', reason: 'evidence_unavailable' };
    for (const attempt of record.attempts) {
      if (
        (attempt.status === 'outcome_unknown' ||
          attempt.failureKind === 'outcome_unknown') &&
        record.status !== 'outcome_unknown'
      )
        return { kind: 'refused', reason: 'unknown_effect' };
      const decision = retryOutcome(record, attempt, policy);
      if (
        decision?.kind === 'outcome_unknown' &&
        record.status !== 'outcome_unknown'
      )
        return { kind: 'refused', reason: 'unknown_effect' };
      if (attempt.retryDecision === 'retry' && decision?.kind !== 'retry')
        return { kind: 'refused', reason: 'evidence_unavailable' };
    }
  }
  const failures = source.nodes.filter(
    (node) => node.status === 'failed' || node.status === 'outcome_unknown',
  );
  if (failures.length > 1)
    return { kind: 'refused', reason: 'multiple_failures' };
  const target = failures[0];
  if (target === undefined || !completeAttempts(target))
    return { kind: 'refused', reason: 'evidence_unavailable' };
  const final = target.attempts.at(-1);
  if (
    final === undefined ||
    !completeFailure(final) ||
    target.status !== source.status ||
    final.retryDecision !== target.status ||
    target.completedAt === null ||
    retryOutcome(target, final, policy)?.kind !== target.status
  )
    return { kind: 'refused', reason: 'evidence_unavailable' };

  const prefix: RecoveryPrefixNode[] = [];
  const choices: RecoveryCandidate['branchSelections'][number][] = [];
  const branchPath: BranchScopePart[] = [];
  let nodeId: string | undefined = tree.rootId;
  while (nodeId !== undefined) {
    const node = nodes.get(nodeId);
    const invocation = invocations.get(nodeId);
    const record = records.get(nodeId);
    if (node === undefined || invocation === undefined)
      return { kind: 'refused', reason: 'prefix_incomplete' };
    const key = invocationKey({
      workflowVersionId: source.workflowVersionId,
      nodeId,
      branchPath: branchPath.map((part) => `${part.nodeId}:${part.outputPort}`),
    });
    if (
      invocation.invocationKey !== key ||
      canonicalJson(invocation.branchPath ?? []) !== canonicalJson(branchPath)
    )
      return { kind: 'refused', reason: 'branch_evidence_unavailable' };
    if (record?.id === target.id) {
      if (node.disabled)
        return { kind: 'refused', reason: 'evidence_unavailable' };
      break;
    }
    if (node.disabled) {
      if (
        node.definition.key === 'core.condition' ||
        invocation.status !== 'skipped' ||
        (record?.attempts.length ?? 0) !== 0
      )
        return { kind: 'refused', reason: 'branch_evidence_unavailable' };
    } else {
      if (record?.status !== 'succeeded' || invocation.output === undefined)
        return { kind: 'refused', reason: 'prefix_incomplete' };
      if (invocation.output.kind === 'artifact')
        return { kind: 'refused', reason: 'artifact_value' };
      if (record.reused !== undefined) {
        if (
          record.currentAttemptId !== null ||
          record.currentAttemptNumber !== null ||
          record.attempts.length !== 0 ||
          invocation.attemptNumber !== 0 ||
          invocation.output.kind !== 'reused' ||
          invocation.output.nodeRunId !== record.id
        )
          return { kind: 'refused', reason: 'evidence_unavailable' };
      } else if (
        !completeAttempts(record) ||
        record.completedAt === null ||
        invocation.attemptNumber !== record.currentAttemptNumber ||
        invocation.output.kind !== 'inline' ||
        invocation.output.attemptId !== record.currentAttemptId
      ) {
        return { kind: 'refused', reason: 'evidence_unavailable' };
      }
      prefix.push({ source: record, invocation, definition: node });
    }
    const outgoing: readonly WorkflowEdge[] = tree.outgoing.get(nodeId) ?? [];
    if (node.definition.key === 'core.condition') {
      const choice = source.checkpoint.branchSelections.find(
        (selection) => selection.invocationKey === key,
      );
      if (
        choice?.nodeId !== nodeId ||
        !['true', 'false'].includes(choice.selectedOutputPort)
      )
        return { kind: 'refused', reason: 'branch_evidence_unavailable' };
      choices.push(choice);
      branchPath.push({ nodeId, outputPort: choice.selectedOutputPort });
      nodeId = outgoing.find(
        (edge) => edge.source.port === choice.selectedOutputPort,
      )?.target.nodeId;
    } else nodeId = outgoing[0]?.target.nodeId;
  }
  if (nodeId !== target.nodeId)
    return { kind: 'refused', reason: 'branch_evidence_unavailable' };
  const prefixIds = new Set(prefix.map((node) => node.source.id));
  for (const record of source.nodes)
    if (
      record.id !== target.id &&
      !prefixIds.has(record.id) &&
      (record.status !== 'skipped' || record.attempts.length > 0)
    )
      return { kind: 'refused', reason: 'suffix_already_executed' };

  return {
    kind: 'candidate',
    source,
    executable,
    target,
    prefix,
    branchSelections: choices,
    effectRisk:
      target.status === 'outcome_unknown'
        ? 'unknown_outcome'
        : target.sideEffectClass !== 'safe' &&
            target.attempts.some(
              (attempt) =>
                attempt.possiblyDispatched === true || attempt.dispatchMarked,
            )
          ? 'possible_effects'
          : 'ordinary',
  };
}
