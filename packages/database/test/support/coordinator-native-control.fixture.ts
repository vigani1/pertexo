import { inspectForEachCollection } from '@pertexo/workflow-model';
import { coordinatorControlPins } from '../../src/execution/coordinator/coordinator-control-facts.js';
import type { loadCoordinatorControlPrecommitMaterial } from '../../src/execution/coordinator/coordinator-control-precommit-material.js';
import type { NativeCoordinatorControlDeclarationSource } from '../../src/execution/coordinator/coordinator-control-declaration-source.js';
import type { ParsedTransitionPlan } from '../../src/execution/coordinator/coordinator-run-store-plan.js';

export const nativeControlId = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
type Material = Awaited<
  ReturnType<typeof loadCoordinatorControlPrecommitMaterial>
>;
export function nativeCoordinatorControlFixture(
  items: readonly unknown[] = ['x'.repeat(300_000)],
) {
  const value = { items, iterationCount: items.length };
  const executable = {
    schemaVersion: 3,
    graph: {
      nodes: [
        {
          id: 'loop',
          definition: { key: 'core.foreach', version: 1 },
          structured: {
            kind: 'for_each',
            maxIterations: 3,
            maxConcurrency: 1,
            body: {
              nodes: [
                { id: 'body', definition: { key: 'core.set', version: 1 } },
              ],
              edges: [],
            },
          },
        },
      ],
    },
  };
  const source: NativeCoordinatorControlDeclarationSource = {
    sequence: 5,
    invocationKey: 'loop',
    nodeId: 'loop',
    attemptId: nativeControlId(5),
    output: { kind: 'artifact', artifactId: nativeControlId(6) },
    controlKind: 'for_each',
    branchPath: [],
    iterationPath: [],
    valueSource: {
      slot: 'upstream_output',
      source: {
        kind: 'physical_output',
        workspaceId: nativeControlId(1),
        runId: nativeControlId(2),
        workflowVersionId: nativeControlId(3),
        nodeId: 'loop',
        invocationKey: 'loop',
        attemptId: nativeControlId(5),
        provenanceId: nativeControlId(7),
      },
      valueIdentity: {
        reference: {
          schemaVersion: 1,
          kind: 'artifact',
          artifactId: nativeControlId(6),
        },
        sha256: 'a'.repeat(64),
        byteLength: 300_100,
        mediaType: 'application/vnd.pertexo.execution-value+json;version=1',
      },
    },
  };
  const material: Material = {
    executable,
    pins: coordinatorControlPins(executable),
    sources: [source],
    checkpoint: {
      schemaVersion: 3,
      engineVersion: 'test',
      workflowVersionId: nativeControlId(3),
      revision: 4,
      runStatus: 'running',
      nextEventSequence: 5,
      readySet: [],
      admittedInvocationKeys: ['loop'],
      invocations: [
        {
          invocationKey: 'loop',
          nodeId: 'loop',
          status: 'running',
          attemptNumber: 1,
        },
      ],
      joins: [],
      loops: [],
      calls: [],
      branchSelections: [],
      remainingIterationBudget: 10,
      cancelRequested: false,
      deadlineExpired: false,
    },
  };
  const plan: ParsedTransitionPlan = {
    expectedRevision: 4,
    expectedNextEventSequence: 5,
    consumedThroughEventSequence: 5,
    events: [],
    attempts: [],
    nodeRunAdmissions: [],
    checkpoint: {
      ...material.checkpoint,
      revision: 5,
      loops: [
        {
          controlInvocationKey: 'loop',
          loopId: 'loop',
          branchPath: [],
          iterationPath: [],
          bodyRootNodeIds: ['body'],
          bodySinkNodeId: 'body',
          collection: source.output,
          ...inspectForEachCollection(value),
          maxIterations: 3,
          maxConcurrency: 1,
          nextOrdinal: 0,
          activeOrdinals: [],
          terminalOrdinals: [],
        },
      ],
    },
  };
  return { material, plan, source, value };
}
