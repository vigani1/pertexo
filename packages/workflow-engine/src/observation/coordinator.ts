import { isHumanTaskDefinition } from '@pertexo/workflow-model';
import { canonicalJson, type JsonValue } from '@pertexo/workflow-model';

import type { parseCheckpoint } from '../checkpoint/create-and-parse.js';
import { executableEdges } from '../compilation/graph.js';
import type {
  CompiledWorkflowExecutable,
  ExecutionNode,
} from '../compilation/foundation.js';
import { completedOutputReference } from './coordinator-output.js';
import {
  configuredBranchOutputPorts,
  configuredParallelOutputPorts,
} from '../transition/scheduling/readiness.js';
import { isCoreMergeDefinition } from '../core-definition-identities.js';
import { exactKeys, operationError, record } from '../operation-values.js';
import { branchPathHasPrefix, sameIterationPath } from '../scope.js';
import { UUID_PATTERN } from '@pertexo/workflow-model';
import { invocationKey as createInvocationKey } from '../transition/scheduling/loops.js';
import type { WorkflowObservation } from '../types.js';

type CheckpointInvocation = ReturnType<
  typeof parseCheckpoint
>['invocations'][number];

export function branchSelectionObservations({
  completedItems,
  successfulOutcomes,
  invocations,
  nodes,
  test = false,
}: Readonly<{
  completedItems: readonly JsonValue[];
  successfulOutcomes: ReadonlyMap<string, Readonly<Record<string, JsonValue>>>;
  invocations: ReadonlyMap<string, CheckpointInvocation>;
  nodes: ReadonlyMap<string, ExecutionNode>;
  test?: boolean | undefined;
}>): readonly WorkflowObservation[] {
  const seen = new Map<string, string>();
  const verifiedParallelOutputs = new Set<string>();
  const observations = completedItems.flatMap((item): WorkflowObservation[] => {
    const material = parseBranchMaterial(item);
    const attemptId = material.attemptId;
    const identity = `${String(material.sequence)}\u0000${material.attemptId}`;
    const canonicalMaterial = canonicalJson(material);
    const previous = seen.get(identity);
    if (previous !== undefined) {
      if (previous !== canonicalMaterial)
        operationError('observation_invalid', 'completed output conflicts');
      return [];
    }
    seen.set(identity, canonicalMaterial);
    const outcomeIdentity = `${String(material.sequence)}\u0000${material.attemptId}\u0000${material.invocationKey}`;
    const correspondingOutcome = successfulOutcomes.get(outcomeIdentity);
    if (
      correspondingOutcome === undefined ||
      completedOutputReference(correspondingOutcome, attemptId) === undefined
    )
      operationError(
        'observation_invalid',
        'completed output has no matching persisted outcome',
      );
    const invocation = invocations.get(material.invocationKey);
    const node = nodes.get(invocation?.nodeId ?? '');
    const ignoresBranchMaterial =
      node === undefined || (!test && isHumanTaskDefinition(node.definition));
    if (ignoresBranchMaterial) return [];
    const parallelPorts = configuredParallelOutputPorts(node);
    if (parallelPorts !== undefined) {
      assertParallelOutput({
        correspondingOutcome,
        attemptId,
        value: material.value,
        parallelPorts,
      });
      verifiedParallelOutputs.add(outcomeIdentity);
      return [];
    }
    const outputPorts = configuredBranchOutputPorts(node);
    if (outputPorts === undefined) return [];
    const completedValue = material.value;
    if (completedValue === undefined)
      operationError('observation_invalid', 'branch output is missing');
    const output = record(
      completedValue,
      'observation_invalid',
      'branch output',
    );
    if (!test || !isHumanTaskDefinition(node.definition))
      exactKeys(output, ['selectedPort']);
    if (
      typeof output.selectedPort !== 'string' ||
      !outputPorts.includes(output.selectedPort)
    )
      operationError('observation_invalid', 'branch output is invalid');
    return [
      {
        kind: 'branch_selected',
        invocationKey: material.invocationKey,
        nodeId: node.id,
        selectedOutputPort: output.selectedPort,
        coordinatorDerived: true,
      },
    ];
  });
  // Only fresh successful facts need material. Previously verified checkpoint
  // successes retain their scoped branch/join authority across recovery.
  for (const [identity, outcome] of successfulOutcomes) {
    const invocation =
      typeof outcome.invocationKey === 'string'
        ? invocations.get(outcome.invocationKey)
        : undefined;
    const node = nodes.get(invocation?.nodeId ?? '');
    const missingParallelMaterial =
      node !== undefined &&
      configuredParallelOutputPorts(node) !== undefined &&
      !verifiedParallelOutputs.has(identity);
    if (missingParallelMaterial)
      operationError('observation_invalid', 'Parallel output is missing');
  }
  return observations;
}

export function mergeCoordinatorObservations(
  executable: CompiledWorkflowExecutable,
  checkpoint: ReturnType<typeof parseCheckpoint>,
  observations: readonly WorkflowObservation[],
  nodes: ReadonlyMap<string, ExecutionNode>,
): readonly WorkflowObservation[] {
  const projected = new Map(
    checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  for (const observation of observations) {
    if (observation.kind !== 'outcome') continue;
    const invocation = projected.get(observation.invocationKey);
    if (invocation === undefined) continue;
    projected.set(observation.invocationKey, {
      ...invocation,
      status: observation.status,
      ...(observation.output === undefined
        ? {}
        : { output: observation.output }),
    });
  }
  const succeededByNode = new Map<string, typeof checkpoint.invocations>();
  for (const invocation of projected.values()) {
    if (invocation.status !== 'succeeded') continue;
    const group = succeededByNode.get(invocation.nodeId) ?? [];
    succeededByNode.set(invocation.nodeId, [...group, invocation]);
  }
  const edges = executableEdges(executable.envelope.graph);
  return [...nodes.values()]
    .filter(({ definition }) => isCoreMergeDefinition(definition))
    .flatMap((merge): WorkflowObservation[] => {
      if (merge.control?.kind !== 'merge')
        operationError('workflow_identity_invalid', 'Merge config is invalid');
      const { parallelNodeId, policy } = merge.control.config;
      const parallel = nodes.get(parallelNodeId);
      const branchIds =
        parallel === undefined
          ? undefined
          : configuredParallelOutputPorts(parallel);
      if (branchIds === undefined)
        operationError('workflow_identity_invalid', 'Merge pairing is invalid');
      const parallelInvocations = succeededByNode.get(parallelNodeId) ?? [];
      return parallelInvocations.flatMap(
        (parallelInvocation): WorkflowObservation[] => {
          const joinInvocationKey = createInvocationKey({
            workflowVersionId: checkpoint.workflowVersionId,
            nodeId: merge.id,
            branchPath: (parallelInvocation.branchPath ?? []).map(
              ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
            ),
            ...(parallelInvocation.iterationPath === undefined
              ? {}
              : { iterationPath: parallelInvocation.iterationPath }),
          });
          const declared: WorkflowObservation = {
            kind: 'join_declared',
            joinId: merge.id,
            joinInvocationKey,
            branchPath: parallelInvocation.branchPath ?? [],
            iterationPath: parallelInvocation.iterationPath ?? [],
            policy,
            branchIds,
            coordinatorDerived: true,
          };
          const dispositions = branchIds.flatMap(
            (branchId): WorkflowObservation[] => {
              const expectedBranchPath = [
                ...(parallelInvocation.branchPath ?? []),
                { nodeId: parallelNodeId, outputPort: branchId },
              ];
              const mergeSourceNodeId = edges.find(
                ({ target }) =>
                  target.nodeId === merge.id && target.port === branchId,
              )?.source.nodeId;
              const scoped = [...projected.values()].filter(
                (invocation) =>
                  sameIterationPath(
                    invocation.iterationPath,
                    parallelInvocation.iterationPath,
                  ) &&
                  branchPathHasPrefix(
                    invocation.branchPath,
                    expectedBranchPath,
                  ),
              );
              if (scoped.length === 0 && mergeSourceNodeId === parallelNodeId)
                return [
                  {
                    kind: 'branch_disposition',
                    joinId: merge.id,
                    joinInvocationKey,
                    coordinatorDerived: true,
                    branch: { branchId, disposition: 'missing' },
                  },
                ];
              if (
                scoped.length === 0 ||
                scoped.some(({ status }) =>
                  ['pending', 'ready', 'running', 'waiting'].includes(status),
                )
              )
                return [];
              const source = scoped.find(
                ({ nodeId }) => nodeId === mergeSourceNodeId,
              );
              // A selected descendant may be admitted on the next transition.
              // Its earlier ancestors cannot settle an arrival without its result.
              if (source === undefined && mergeSourceNodeId !== parallelNodeId)
                return [];
              const statuses = new Set(scoped.map(({ status }) => status));
              const disposition = settledBranchDisposition(statuses);

              return [
                {
                  kind: 'branch_disposition',
                  joinId: merge.id,
                  joinInvocationKey,
                  coordinatorDerived: true,
                  branch: {
                    branchId,
                    disposition,
                    ...(disposition === 'arrived' &&
                    source?.output !== undefined
                      ? { output: source.output }
                      : {}),
                  },
                },
              ];
            },
          );
          return [declared, ...dispositions];
        },
      );
    });
}

function parseBranchMaterial(item: JsonValue) {
  const material = record(item, 'observation_invalid', 'completed output');
  const { sequence, attemptId, invocationKey } = material;

  exactKeys(material, ['sequence', 'attemptId', 'invocationKey', 'value']);
  const invalidMaterialIdentity =
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    typeof attemptId !== 'string' ||
    !UUID_PATTERN.test(attemptId) ||
    typeof invocationKey !== 'string';
  if (invalidMaterialIdentity)
    operationError(
      'observation_invalid',
      'completed output identity is invalid',
    );
  return {
    value: material.value,
    sequence: sequence,
    attemptId: attemptId,
    invocationKey: invocationKey,
  };
}

function settledBranchDisposition(
  statuses: ReadonlySet<string>,
): 'failed' | 'canceled' | 'skipped' | 'arrived' {
  const failed =
    statuses.has('failed') ||
    statuses.has('timed_out') ||
    statuses.has('outcome_unknown');
  if (failed) return 'failed';
  if (statuses.has('canceled')) return 'canceled';
  if (statuses.size === 1 && statuses.has('skipped')) return 'skipped';
  return 'arrived';
}

function assertParallelOutput({
  correspondingOutcome,
  attemptId,
  value,
  parallelPorts,
}: Readonly<{
  correspondingOutcome: Readonly<Record<string, JsonValue>>;
  attemptId: string;
  value: JsonValue | undefined;
  parallelPorts: readonly string[];
}>): void {
  if (
    completedOutputReference(correspondingOutcome, attemptId)?.kind !== 'inline'
  )
    operationError(
      'observation_invalid',
      'Parallel output reference is invalid',
    );
  if (value === undefined)
    operationError('observation_invalid', 'Parallel output is missing');
  const completedValue = record(
    value,
    'observation_invalid',
    'Parallel output',
  );
  exactKeys(completedValue, ['branchIds']);
  const invalidParallelOutput =
    !Array.isArray(completedValue.branchIds) ||
    completedValue.branchIds.length !== parallelPorts.length ||
    completedValue.branchIds.some(
      (branchId, index) => branchId !== parallelPorts[index],
    );
  if (invalidParallelOutput)
    operationError('observation_invalid', 'Parallel output is invalid');
}
