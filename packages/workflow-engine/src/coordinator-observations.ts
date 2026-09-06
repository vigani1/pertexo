import { createHash } from 'node:crypto';

import {
  canonicalJson,
  type JsonValue,
} from '@pertexo/workflow-model/canonical-json';

import type { parseCheckpoint } from './checkpoint.js';
import { executableEdges } from './executable-graph.js';
import type {
  CompiledWorkflowExecutableV2,
  WorkflowExecutableNodeV2,
} from './executable-workflow.js';
import { completedOutputReference } from './coordinator-output.js';
import {
  configuredBranchOutputPorts,
  configuredParallelOutputPorts,
} from './graph-scheduler.js';
import { isCoreMergeDefinition } from './core-definition-identities.js';
import {
  exactKeys,
  isJsonRecord,
  operationError,
  record,
} from './operation-values.js';
import { compareOrdinal } from './ordering.js';
import { branchPathHasPrefix, sameIterationPath } from './scope.js';
import { uuidPattern } from './persisted-observations.js';
import { invocationKey as createInvocationKey } from './scheduling.js';
import type { JoinPolicy, WorkflowObservation } from './types.js';

type CheckpointInvocation = ReturnType<
  typeof parseCheckpoint
>['invocations'][number];

export function branchSelectionObservations(
  completedItems: readonly JsonValue[],
  successfulOutcomes: ReadonlyMap<string, Readonly<Record<string, JsonValue>>>,
  invocations: ReadonlyMap<string, CheckpointInvocation>,
  nodes: ReadonlyMap<string, WorkflowExecutableNodeV2>,
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

export function forEachCoordinatorObservations(
  completedItems: readonly JsonValue[],
  persistedItems: readonly JsonValue[],
  successfulOutcomes: ReadonlyMap<string, Readonly<Record<string, JsonValue>>>,
  checkpoint: ReturnType<typeof parseCheckpoint>,
  invocations: ReadonlyMap<string, CheckpointInvocation>,
  nodes: ReadonlyMap<string, WorkflowExecutableNodeV2>,
  derivedObservations: readonly WorkflowObservation[] = [],
): Readonly<{
  observations: readonly WorkflowObservation[];
  declarationInvocationKeys: ReadonlySet<string>;
}> {
  const declarations = new Set<string>();
  const declarationMaterials = new Map<string, string>();
  const observations: WorkflowObservation[] = [];
  const terminalOutcomes = new Map<
    string,
    | 'succeeded'
    | 'skipped'
    | 'failed'
    | 'canceled'
    | 'timed_out'
    | 'outcome_unknown'
  >();
  for (const candidate of persistedItems) {
    if (
      isJsonRecord(candidate) &&
      candidate.kind === 'outcome' &&
      typeof candidate.invocationKey === 'string' &&
      typeof candidate.status === 'string' &&
      [
        'succeeded',
        'failed',
        'canceled',
        'timed_out',
        'outcome_unknown',
      ].includes(candidate.status)
    )
      terminalOutcomes.set(
        candidate.invocationKey,
        candidate.status as
          'succeeded' | 'failed' | 'canceled' | 'timed_out' | 'outcome_unknown',
      );
  }
  for (const candidate of derivedObservations) {
    if (candidate.kind === 'outcome' && candidate.status !== 'skipped')
      terminalOutcomes.set(candidate.invocationKey, candidate.status);
  }
  for (const item of completedItems) {
    const material = record(item, 'observation_invalid', 'completed output');
    exactKeys(material, ['sequence', 'attemptId', 'invocationKey', 'value']);
    if (
      typeof material.sequence !== 'number' ||
      !Number.isSafeInteger(material.sequence) ||
      typeof material.attemptId !== 'string' ||
      !uuidPattern.test(material.attemptId) ||
      typeof material.invocationKey !== 'string'
    )
      operationError(
        'observation_invalid',
        'completed output identity is invalid',
      );
    const outcome = successfulOutcomes.get(
      `${String(material.sequence)}\u0000${material.attemptId}\u0000${material.invocationKey}`,
    );
    if (outcome === undefined)
      operationError(
        'observation_invalid',
        'completed output has no matching persisted outcome',
      );
    const invocation = invocations.get(material.invocationKey);
    const node = nodes.get(invocation?.nodeId ?? '');
    if (
      invocation === undefined ||
      node?.definition.key !== 'core.foreach' ||
      node.definition.version !== 1 ||
      node.structured?.kind !== 'for_each'
    )
      continue;
    const canonicalMaterial = canonicalJson(material);
    const previousMaterial = declarationMaterials.get(invocation.invocationKey);
    if (previousMaterial !== undefined) {
      if (previousMaterial !== canonicalMaterial)
        operationError(
          'observation_invalid',
          'For Each declaration output conflicts',
        );
      continue;
    }
    declarationMaterials.set(invocation.invocationKey, canonicalMaterial);
    if (material.value === undefined)
      operationError('observation_invalid', 'For Each output is missing');
    const output = record(
      material.value,
      'observation_invalid',
      'For Each output',
    );
    exactKeys(output, ['items', 'iterationCount']);
    if (
      !Array.isArray(output.items) ||
      typeof output.iterationCount !== 'number' ||
      !Number.isSafeInteger(output.iterationCount) ||
      output.iterationCount !== output.items.length
    )
      operationError('observation_invalid', 'For Each output is invalid');
    const body = node.structured.body;
    const targets = new Set(body.edges.map(({ target }) => target.nodeId));
    const sources = new Set(body.edges.map(({ source }) => source.nodeId));
    const roots = body.nodes
      .map(({ id }) => id)
      .filter((id) => !targets.has(id))
      .sort(compareOrdinal);
    const sinks = body.nodes
      .map(({ id }) => id)
      .filter((id) => !sources.has(id));
    const outputReference = completedOutputReference(
      outcome,
      material.attemptId,
    );
    if (outputReference === undefined)
      operationError(
        'observation_invalid',
        'For Each output reference is invalid',
      );
    declarations.add(invocation.invocationKey);
    observations.push({
      kind: 'loop_started',
      loopId: node.id,
      controlInvocationKey: invocation.invocationKey,
      branchPath: invocation.branchPath ?? [],
      iterationPath: invocation.iterationPath ?? [],
      bodyRootNodeIds: roots,
      bodySinkNodeId: sinks[0] ?? '',
      collection: outputReference,
      collectionChecksum: createHash('sha256')
        .update(canonicalJson(output.items))
        .digest('hex'),
      collectionSize: output.items.length,
      maxIterations: node.structured.maxIterations,
      maxConcurrency: node.structured.maxConcurrency,
      coordinatorDerived: true,
    });
  }
  for (const loop of checkpoint.loops) {
    for (const ordinal of loop.activeOrdinals) {
      const iterationPath = [
        ...loop.iterationPath,
        { loopNodeId: loop.loopId, ordinal },
      ];
      const sinkKey = createInvocationKey({
        workflowVersionId: checkpoint.workflowVersionId,
        nodeId: loop.bodySinkNodeId,
        branchPath: loop.branchPath.map(
          ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
        ),
        iterationPath,
      });
      const failedInvocation = checkpoint.invocations.find(
        (invocation) =>
          sameIterationPath(invocation.iterationPath, iterationPath) &&
          ['failed', 'canceled', 'timed_out', 'outcome_unknown'].includes(
            terminalOutcomes.get(invocation.invocationKey) ?? '',
          ),
      );
      const terminalInvocationKey = failedInvocation?.invocationKey ?? sinkKey;
      const checkpointSink = invocations.get(sinkKey);
      const terminalStatus =
        terminalOutcomes.get(terminalInvocationKey) ??
        (checkpointSink?.status === 'skipped' ? 'skipped' : undefined);
      if (terminalStatus === undefined) continue;
      observations.push({
        kind: 'loop_iteration_completed',
        loopId: loop.loopId,
        controlInvocationKey: loop.controlInvocationKey,
        ...(failedInvocation === undefined
          ? {}
          : { invocationKey: failedInvocation.invocationKey }),
        ordinal,
        status: terminalStatus,
        coordinatorDerived: true,
      });
    }
  }
  observations.sort((left, right) => {
    const leftKey =
      left.kind === 'loop_started' || left.kind === 'loop_iteration_completed'
        ? `${left.controlInvocationKey ?? left.loopId}:${left.kind === 'loop_started' ? '0' : '1'}:${left.kind === 'loop_iteration_completed' ? String(left.ordinal).padStart(16, '0') : ''}`
        : '';
    const rightKey =
      right.kind === 'loop_started' || right.kind === 'loop_iteration_completed'
        ? `${right.controlInvocationKey ?? right.loopId}:${right.kind === 'loop_started' ? '0' : '1'}:${right.kind === 'loop_iteration_completed' ? String(right.ordinal).padStart(16, '0') : ''}`
        : '';
    return compareOrdinal(leftKey, rightKey);
  });
  return { observations, declarationInvocationKeys: declarations };
}
export function mergeCoordinatorObservations(
  executable: CompiledWorkflowExecutableV2,
  checkpoint: ReturnType<typeof parseCheckpoint>,
  observations: readonly WorkflowObservation[],
  nodes: ReadonlyMap<string, WorkflowExecutableNodeV2>,
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
