import { inspectForEachCollection } from '@pertexo/workflow-model';

import {
  canonicalJson,
  type JsonValue,
} from '@pertexo/workflow-model/canonical-json';
import { workflowControlOutputKind } from '@pertexo/workflow-model/graph';

import type { parseCheckpoint } from '../checkpoint/checkpoint.js';
import type { WorkflowExecutableNodeV2 } from '../executable-workflow.js';
import { completedOutputReference } from './coordinator-output.js';
import {
  exactKeys,
  isJsonRecord,
  operationError,
  record,
} from '../operation-values.js';
import { compareOrdinal } from '../ordering.js';
import { branchPathHasPrefix, sameIterationPath } from '../scope.js';
import { uuidPattern } from './persisted-observations.js';
import {
  isTerminalNodeStatus,
  scopedLoopSinkInvocation,
} from '../transition/workflow-transition-state.js';
import type { WorkflowObservation } from '../types.js';

type CheckpointInvocation = ReturnType<
  typeof parseCheckpoint
>['invocations'][number];
type TerminalLoopStatus = Extract<
  CheckpointInvocation['status'],
  | 'succeeded'
  | 'skipped'
  | 'failed'
  | 'canceled'
  | 'timed_out'
  | 'outcome_unknown'
>;

function terminalLoopStatus(
  status: CheckpointInvocation['status'] | undefined,
): TerminalLoopStatus | undefined {
  return isTerminalNodeStatus(status) ? status : undefined;
}

function terminalOutcomesForLoop(
  persistedItems: readonly JsonValue[],
  derivedObservations: readonly WorkflowObservation[],
): ReadonlyMap<string, TerminalLoopStatus> {
  const terminalOutcomes = new Map<string, TerminalLoopStatus>();
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
        candidate.status as TerminalLoopStatus,
      );
  }
  for (const candidate of derivedObservations) {
    if (candidate.kind === 'outcome' && candidate.status !== 'skipped')
      terminalOutcomes.set(candidate.invocationKey, candidate.status);
  }
  return terminalOutcomes;
}

function loopObservationKey(observation: WorkflowObservation): string {
  if (
    observation.kind !== 'loop_started' &&
    observation.kind !== 'loop_iteration_completed'
  )
    return '';
  const controlKey = observation.controlInvocationKey ?? observation.loopId;
  if (observation.kind === 'loop_started') return `${controlKey}:0:`;
  return `${controlKey}:1:${String(observation.ordinal).padStart(16, '0')}`;
}

export function orderForEachObservations(
  observations: readonly WorkflowObservation[],
): readonly WorkflowObservation[] {
  return [...observations].sort((left, right) =>
    compareOrdinal(loopObservationKey(left), loopObservationKey(right)),
  );
}

export function forEachCoordinatorObservations(
  completedItems: readonly JsonValue[],
  persistedItems: readonly JsonValue[],
  successfulOutcomes: ReadonlyMap<string, Readonly<Record<string, JsonValue>>>,
  checkpoint: ReturnType<typeof parseCheckpoint>,
  invocations: ReadonlyMap<string, CheckpointInvocation>,
  nodes: ReadonlyMap<string, WorkflowExecutableNodeV2>,
  derivedObservations: readonly WorkflowObservation[] = [],
  knownDeclarationInvocationKeys: ReadonlySet<string> = new Set(),
): Readonly<{
  observations: readonly WorkflowObservation[];
  declarationInvocationKeys: ReadonlySet<string>;
}> {
  const declarations = new Set(knownDeclarationInvocationKeys);
  const declarationMaterials = new Map<string, string>();
  const observations: WorkflowObservation[] = [];
  const terminalOutcomes = terminalOutcomesForLoop(
    persistedItems,
    derivedObservations,
  );
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
      node === undefined ||
      workflowControlOutputKind(node.definition) !== 'for_each' ||
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
    let collection;
    try {
      collection = inspectForEachCollection(material.value);
    } catch {
      operationError('observation_invalid', 'For Each output is invalid');
    }
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
      collectionChecksum: collection.collectionChecksum,
      collectionSize: collection.collectionSize,
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
      const failedInvocation = checkpoint.invocations.find((invocation) => {
        const status =
          terminalOutcomes.get(invocation.invocationKey) ?? invocation.status;
        return (
          sameIterationPath(invocation.iterationPath, iterationPath) &&
          branchPathHasPrefix(invocation.branchPath, loop.branchPath) &&
          isTerminalNodeStatus(status) &&
          status !== 'succeeded' &&
          status !== 'skipped'
        );
      });
      const checkpointSink = scopedLoopSinkInvocation(
        loop,
        ordinal,
        checkpoint.invocations,
      );
      const terminalInvocationKey =
        failedInvocation?.invocationKey ?? checkpointSink?.invocationKey;
      const terminalStatus =
        terminalInvocationKey === undefined ||
        declarations.has(terminalInvocationKey)
          ? undefined
          : (terminalOutcomes.get(terminalInvocationKey) ??
            terminalLoopStatus(
              failedInvocation?.status ?? checkpointSink?.status,
            ));
      if (terminalStatus === undefined || terminalInvocationKey === undefined)
        continue;
      observations.push({
        kind: 'loop_iteration_completed',
        loopId: loop.loopId,
        controlInvocationKey: loop.controlInvocationKey,
        invocationKey: terminalInvocationKey,
        ordinal,
        status: terminalStatus,
        coordinatorDerived: true,
      });
    }
  }
  return {
    observations: orderForEachObservations(observations),
    declarationInvocationKeys: declarations,
  };
}
