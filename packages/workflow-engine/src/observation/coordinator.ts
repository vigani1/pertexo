import { canonicalJson, type JsonValue } from '@pertexo/workflow-model';

import type { parseCheckpoint } from '../checkpoint/create-and-parse.js';
import { executableEdges } from '../compilation/graph.js';
import type {
  CompiledWorkflowExecutable,
  WorkflowExecutableNode,
} from '../compilation/foundation.js';
import { completedOutputReference } from './coordinator-output.js';
import {
  configuredBranchOutputPorts,
  configuredParallelOutputPorts,
} from '../transition/scheduler.js';
import { isCoreMergeDefinition } from '../core-definition-identities.js';
import { exactKeys, operationError, record } from '../operation-values.js';
import { branchPathHasPrefix, sameIterationPath } from '../scope.js';
import { uuidPattern } from './persisted.js';
import { invocationKey as createInvocationKey } from '../transition/scheduling.js';
import type { JoinPolicy, WorkflowObservation } from '../types.js';

type CheckpointInvocation = ReturnType<
  typeof parseCheckpoint
>['invocations'][number];

export function branchSelectionObservations(
  completedItems: readonly JsonValue[],
  successfulOutcomes: ReadonlyMap<string, Readonly<Record<string, JsonValue>>>,
  invocations: ReadonlyMap<string, CheckpointInvocation>,
  nodes: ReadonlyMap<string, WorkflowExecutableNode>,
): readonly WorkflowObservation[] {
  const seen = new Map<string, string>();
  const verifiedParallelOutputs = new Set<string>();
  const observations = completedItems.flatMap((item): WorkflowObservation[] => {
    const material = record(item, 'observation_invalid', 'completed output');
    exactKeys(material, ['sequence', 'attemptId', 'invocationKey', 'value']);
    if (
      typeof material.sequence !== 'number' ||
      !Number.isSafeInteger(material.sequence) ||
      material.sequence < 1 ||
      typeof material.attemptId !== 'string' ||
      !uuidPattern.test(material.attemptId) ||
      typeof material.invocationKey !== 'string'
    )
      operationError(
        'observation_invalid',
        'completed output identity is invalid',
      );
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
    if (node === undefined) return [];
    const parallelPorts = configuredParallelOutputPorts(node);
    if (parallelPorts !== undefined) {
      if (
        completedOutputReference(correspondingOutcome, attemptId)?.kind !==
        'inline'
      )
        operationError(
          'observation_invalid',
          'Parallel output reference is invalid',
        );
      if (material.value === undefined)
        operationError('observation_invalid', 'Parallel output is missing');
      const completedValue = record(
        material.value,
        'observation_invalid',
        'Parallel output',
      );
      exactKeys(completedValue, ['branchIds']);
      if (
        !Array.isArray(completedValue.branchIds) ||
        completedValue.branchIds.length !== parallelPorts.length ||
        completedValue.branchIds.some(
          (branchId, index) => branchId !== parallelPorts[index],
        )
      )
        operationError('observation_invalid', 'Parallel output is invalid');
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
    if (
      node !== undefined &&
      configuredParallelOutputPorts(node) !== undefined &&
      !verifiedParallelOutputs.has(identity)
    )
      operationError('observation_invalid', 'Parallel output is missing');
  }
  return observations;
}

export function mergeCoordinatorObservations(
  executable: CompiledWorkflowExecutable,
  checkpoint: ReturnType<typeof parseCheckpoint>,
  observations: readonly WorkflowObservation[],
  nodes: ReadonlyMap<string, WorkflowExecutableNode>,
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
      const parallelNodeId = Reflect.get(
        merge.config,
        'parallelNodeId',
      ) as unknown;
      const policy = Reflect.get(merge.config, 'policy') as unknown;
      if (
        typeof parallelNodeId !== 'string' ||
        typeof policy !== 'object' ||
        policy === null
      )
        operationError('workflow_identity_invalid', 'Merge config is invalid');
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
            policy: policy as JoinPolicy,
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
              const statuses = new Set(scoped.map(({ status }) => status));
              const disposition =
                statuses.has('failed') ||
                statuses.has('timed_out') ||
                statuses.has('outcome_unknown')
                  ? 'failed'
                  : statuses.has('canceled')
                    ? 'canceled'
                    : statuses.size === 1 && statuses.has('skipped')
                      ? 'skipped'
                      : 'arrived';
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
