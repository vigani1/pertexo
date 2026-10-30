import { isPendingTaskNode } from '@pertexo/workflow-model';
import {
  canonicalJson,
  inspectWorkflowDecisionTree,
  type WorkflowEdge,
  type StepRetrySettings,
  WORKFLOW_FAILURE_PORT,
} from '@pertexo/workflow-model';
import {
  assertAuthenticExecutableIdentity,
  executionNodes,
} from '../compilation/foundation.js';
import { assertCheckpointMatchesExecutable } from '../checkpoint/matches-executable.js';
import {
  decideRetry,
  resolveRetryPolicy,
  type RetryPolicy,
} from '../attempt/retries.js';
import { invocationKey } from '../transition/scheduling/loops.js';
import type { BranchScopePart, InvocationState } from '../types.js';
import type {
  RecoveryAttempt,
  RecoveryCandidate,
  RecoveryNode,
  RecoveryPrefixNode,
  RecoveryRefused,
  RecoverySource,
} from './contract.js';
import type {
  CompiledWorkflowExecutable,
  WorkflowExecutableNode,
} from '../compilation/foundation.js';

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
  const incompleteAttemptCount =
    node.currentAttemptNumber === null ||
    node.currentAttemptNumber < 1 ||
    node.attempts.length !== node.currentAttemptNumber;
  if (incompleteAttemptCount) return false;
  for (const [index, attempt] of node.attempts.entries()) {
    if (attempt.number !== index + 1) return false;
    const invalidPriorAttempt =
      index < node.attempts.length - 1 &&
      (!completeFailure(attempt) ||
        attempt.status !== 'failed' ||
        attempt.retryDecision !== 'retry');
    if (invalidPriorAttempt) return false;
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
  settings?: StepRetrySettings,
) {
  if (!completeFailure(attempt)) return undefined;
  return decideRetry({
    sideEffectClass: node.sideEffectClass,
    currentAttemptNumber: attempt.number,
    policy,
    settings,
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
  const tree = graph.nodes.some((node) => isPendingTaskNode(node))
    ? undefined
    : inspectWorkflowDecisionTree(graph);
  if (
    tree === undefined ||
    graph.edges.some((edge) => edge.source.port === WORKFLOW_FAILURE_PORT)
  )
    return { kind: 'refused', reason: 'unsupported_graph' };
  if (!sourceEvidenceComplete(source))
    return { kind: 'refused', reason: 'evidence_unavailable' };
  // A decision tree has no loop bodies, so these are the graph's own steps.
  assertCheckpointMatchesExecutable(
    source.checkpoint,
    executable,
    executionNodes(executable),
  );
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const records = new Map(source.nodes.map((node) => [node.nodeId, node]));
  const invocations = new Map(
    source.checkpoint.invocations.map((invocation) => [
      invocation.nodeId,
      invocation,
    ]),
  );
  const incompleteRecordSet =
    records.size !== source.nodes.length ||
    invocations.size !== source.checkpoint.invocations.length ||
    source.checkpoint.invocations.some(
      (invocation) =>
        invocation.status !== 'skipped' && !records.has(invocation.nodeId),
    );
  if (incompleteRecordSet)
    return { kind: 'refused', reason: 'evidence_unavailable' };
  const policy = resolveRetryPolicy(executable.envelope.runtimePolicies.retry);
  const context = { source, nodes, records, invocations, policy };
  const evidenceFailure = verifyRecoveryRecords(context);
  if (evidenceFailure !== undefined) return evidenceFailure;
  const selectedTarget = selectRecoveryTarget(context);
  if ('kind' in selectedTarget) return selectedTarget;
  const target = selectedTarget;

  const selectedPath = selectExecutedPath(context, tree, target);
  if ('kind' in selectedPath) return selectedPath;
  const { prefix, choices } = selectedPath;
  const prefixIds = new Set(prefix.map((node) => node.source.id));
  for (const record of source.nodes) {
    const executedSuffix =
      record.id !== target.id &&
      !prefixIds.has(record.id) &&
      (record.status !== 'skipped' || record.attempts.length > 0);
    if (executedSuffix)
      return { kind: 'refused', reason: 'suffix_already_executed' };
  }

  return {
    kind: 'candidate',
    source,
    executable,
    target,
    prefix,
    branchSelections: choices,
    effectRisk: recoveryEffectRisk(target),
  };
}

interface RecoveryContext {
  readonly source: RecoverySource;
  readonly nodes: ReadonlyMap<string, WorkflowExecutableNode>;
  readonly records: ReadonlyMap<string, RecoveryNode>;
  readonly invocations: ReadonlyMap<string, InvocationState>;
  readonly policy: RetryPolicy;
}
function verifyRecoveryRecords({
  source,
  nodes,
  invocations,
  policy,
}: RecoveryContext): RecoveryRefused | undefined {
  for (const record of source.nodes) {
    const node = nodes.get(record.nodeId);
    const invocation = invocations.get(record.nodeId);
    const recordMismatch =
      node?.sideEffectClass !== record.sideEffectClass ||
      invocation?.invocationKey !== record.invocationKey ||
      invocation.status !== record.status ||
      invocation.attemptNumber !== (record.currentAttemptNumber ?? 0) ||
      canonicalJson(invocation.branchPath ?? []) !==
        canonicalJson(record.branchPath ?? []) ||
      (record.iterationPath?.length ?? 0) !== 0 ||
      (invocation.iterationPath?.length ?? 0) !== 0;
    if (recordMismatch)
      return { kind: 'refused', reason: 'evidence_unavailable' };
    const retryFailure = verifyRetryHistory(record, node, policy);
    if (retryFailure !== undefined) return retryFailure;
  }
  return undefined;
}
function selectRecoveryTarget({
  source,
  nodes,
  policy,
}: RecoveryContext): RecoveryNode | RecoveryRefused {
  const failures = source.nodes.filter(
    (node) => node.status === 'failed' || node.status === 'outcome_unknown',
  );
  if (failures.length > 1)
    return { kind: 'refused', reason: 'multiple_failures' };
  const target = failures[0];
  if (target === undefined || !completeAttempts(target))
    return { kind: 'refused', reason: 'evidence_unavailable' };
  const final = target.attempts.at(-1);
  const incompleteFinalFailure =
    final === undefined ||
    !completeFailure(final) ||
    target.status !== source.status ||
    final.retryDecision !== target.status ||
    target.completedAt === null ||
    retryOutcome(target, final, policy, nodes.get(target.nodeId)?.retry)
      ?.kind !== target.status;
  if (incompleteFinalFailure)
    return { kind: 'refused', reason: 'evidence_unavailable' };
  return target;
}
function recoveryEffectRisk(
  target: RecoveryNode,
): RecoveryCandidate['effectRisk'] {
  if (target.status === 'outcome_unknown') return 'unknown_outcome';
  const possibleEffects =
    target.sideEffectClass !== 'safe' &&
    target.attempts.some(
      (attempt) =>
        (attempt.possiblyDispatched ?? false) || attempt.dispatchMarked,
    );
  return possibleEffects ? 'possible_effects' : 'ordinary';
}
function selectExecutedPath(
  { source, nodes, invocations, records }: RecoveryContext,
  tree: NonNullable<ReturnType<typeof inspectWorkflowDecisionTree>>,
  target: RecoveryNode,
):
  | Readonly<{
      prefix: readonly RecoveryPrefixNode[];
      choices: RecoveryCandidate['branchSelections'];
    }>
  | RecoveryRefused {
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
    const completedPrefix = verifyPrefixOutput({ node, invocation, record });
    if (completedPrefix !== undefined) {
      if ('kind' in completedPrefix) return completedPrefix;
      prefix.push(completedPrefix);
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
  return { prefix, choices };
}

function verifyPrefixOutput({
  node,
  invocation,
  record,
}: Readonly<{
  node: WorkflowExecutableNode;
  invocation: InvocationState;
  record: RecoveryNode | undefined;
}>): RecoveryPrefixNode | RecoveryRefused | undefined {
  if (node.disabled) {
    const invalidDisabledPrefix =
      node.definition.key === 'core.condition' ||
      invocation.status !== 'skipped' ||
      (record?.attempts.length ?? 0) !== 0;
    if (invalidDisabledPrefix)
      return { kind: 'refused', reason: 'branch_evidence_unavailable' };
  } else {
    if (record?.status !== 'succeeded' || invocation.output === undefined)
      return { kind: 'refused', reason: 'prefix_incomplete' };
    if (invocation.output.kind === 'artifact')
      return { kind: 'refused', reason: 'artifact_value' };
    const outputFailure = verifyPrefixAttempt(
      record,
      invocation,
      invocation.output,
    );
    if (outputFailure !== undefined) return outputFailure;
    return { source: record, invocation, definition: node };
  }
  return undefined;
}

function verifyRetryHistory(
  record: RecoveryNode,
  node: WorkflowExecutableNode,
  policy: RetryPolicy,
): RecoveryRefused | undefined {
  for (const attempt of record.attempts) {
    const unknownPriorEffect =
      (attempt.status === 'outcome_unknown' ||
        attempt.failureKind === 'outcome_unknown') &&
      record.status !== 'outcome_unknown';
    if (unknownPriorEffect)
      return { kind: 'refused', reason: 'unknown_effect' };
    const decision = retryOutcome(record, attempt, policy, node.retry);
    if (
      decision?.kind === 'outcome_unknown' &&
      record.status !== 'outcome_unknown'
    )
      return { kind: 'refused', reason: 'unknown_effect' };
    if (attempt.retryDecision === 'retry' && decision?.kind !== 'retry')
      return { kind: 'refused', reason: 'evidence_unavailable' };
  }
  return undefined;
}

function sourceEvidenceComplete(source: RecoverySource): boolean {
  const missingSourceEvidence =
    source.completedAt === null ||
    source.workflowVersionId !== source.checkpoint.workflowVersionId ||
    source.checkpoint.runStatus !== source.status ||
    source.checkpoint.cancelRequested ||
    source.checkpoint.deadlineExpired ||
    source.checkpoint.joins.length > 0 ||
    source.checkpoint.loops.length > 0;
  if (missingSourceEvidence) return false;
  return true;
}

function verifyPrefixAttempt(
  record: RecoveryNode,
  invocation: InvocationState,
  output: NonNullable<InvocationState['output']>,
): RecoveryRefused | undefined {
  if (record.reused !== undefined) {
    const invalidReusedPrefix =
      record.currentAttemptId !== null ||
      record.currentAttemptNumber !== null ||
      record.attempts.length !== 0 ||
      invocation.attemptNumber !== 0 ||
      output.kind !== 'reused' ||
      output.nodeRunId !== record.id;
    if (invalidReusedPrefix)
      return { kind: 'refused', reason: 'evidence_unavailable' };
  } else {
    const invalidAttemptPrefix =
      !completeAttempts(record) ||
      record.completedAt === null ||
      invocation.attemptNumber !== record.currentAttemptNumber ||
      output.kind !== 'inline' ||
      output.attemptId !== record.currentAttemptId;
    if (invalidAttemptPrefix) {
      return { kind: 'refused', reason: 'evidence_unavailable' };
    }
  }
  return undefined;
}
