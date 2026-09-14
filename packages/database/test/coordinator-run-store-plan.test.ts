import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import type { PersistedWorkflowCheckpoint } from '../src/compatibility/persisted-workflow-checkpoint.js';
import {
  type ParsedTransitionPlan,
  validateTransitionDelta,
} from '../src/execution/coordinator-run-store-plan.js';

type Invocation = PersistedWorkflowCheckpoint['invocations'][number];

function loopCheckpoint(
  population: number,
  orderedInvocations?: readonly Invocation[],
): PersistedWorkflowCheckpoint {
  const branchPath = [{ nodeId: 'switch', outputPort: 'selected' }];
  const control = {
    invocationKey: 'loop-control',
    nodeId: 'loop',
    status: 'waiting',
    attemptNumber: 1,
    branchPath,
    iterationPath: [],
    output: { kind: 'inline', attemptId: randomUUID() },
  } as const;
  const invocations = Array.from({ length: population }, (_, ordinal) => ({
    invocationKey: `body-${String(ordinal)}`,
    nodeId: 'body',
    status: 'ready' as const,
    attemptNumber: 0,
    branchPath,
    iterationPath: [{ loopNodeId: 'loop', ordinal }],
  }));
  return {
    schemaVersion: 2,
    engineVersion: 'engine-v1',
    workflowVersionId: randomUUID(),
    revision: 0,
    runStatus: 'running',
    nextEventSequence: 2,
    readySet: [],
    admittedInvocationKeys: [],
    invocations: orderedInvocations ?? [control, ...invocations],
    joins: [],
    loops: [
      {
        controlInvocationKey: control.invocationKey,
        loopId: 'loop',
        branchPath,
        iterationPath: [],
        bodyRootNodeIds: ['body'],
        bodySinkNodeId: 'body',
        collection: control.output,
        collectionChecksum: 'a'.repeat(64),
        collectionSize: population,
        maxConcurrency: population,
        maxIterations: population,
        nextOrdinal: population,
        activeOrdinals: Array.from({ length: population }, (_, index) => index),
        terminalOrdinals: [],
      },
    ],
    remainingIterationBudget: 0,
    initialIterationBudget: population,
    branchSelections: [],
    cancelRequested: false,
    deadlineExpired: false,
  } as PersistedWorkflowCheckpoint;
}

function unchangedPlan(
  current: PersistedWorkflowCheckpoint,
  invocations: readonly Invocation[] = current.invocations,
): ParsedTransitionPlan {
  return {
    expectedRevision: current.revision,
    expectedNextEventSequence: current.nextEventSequence,
    consumedThroughEventSequence: current.nextEventSequence - 1,
    checkpoint: {
      ...current,
      revision: current.revision + 1,
      invocations: [...invocations],
    },
    events: [],
    nodeRunAdmissions: [],
    attempts: [],
  };
}

describe('coordinator plan scoped-invocation index', () => {
  it.each([1, 500, 1_000])(
    'validates a fixed %i-active-ordinal workload after reordering',
    (population) => {
      const current = loopCheckpoint(population);
      const nextInvocations = [...current.invocations].reverse();
      const heapBefore = process.memoryUsage().heapUsed;
      const started = performance.now();
      expect(() => {
        validateTransitionDelta(
          current,
          unchangedPlan(current, nextInvocations),
        );
      }).not.toThrow();
      const operationMs = performance.now() - started;
      console.info(
        `Q12_SCOPED_INVOCATION_INDEX_V1=${JSON.stringify({
          schemaVersion: 1,
          population,
          indexEntries: current.invocations.length,
          scopedLookups: population,
          operationMs,
          processHeapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
          attributableMemory: false,
        })}`,
      );
    },
  );

  it('preserves first-match semantics for duplicate scoped roots', () => {
    const current = loopCheckpoint(1);
    const validRoot = current.invocations.find(
      ({ invocationKey }) => invocationKey === 'body-0',
    );
    if (validRoot === undefined) throw new Error('missing valid root');
    const invalidFirst = {
      ...validRoot,
      invocationKey: 'body-invalid-first',
      status: 'failed' as const,
    };
    const control = current.invocations[0];
    if (control === undefined) throw new Error('missing loop control');
    const currentWithDuplicate = {
      ...current,
      invocations: [control, invalidFirst, validRoot],
    } as PersistedWorkflowCheckpoint;

    expect(() => {
      validateTransitionDelta(
        currentWithDuplicate,
        unchangedPlan(currentWithDuplicate),
      );
    }).toThrow();
    expect(() => {
      validateTransitionDelta(
        currentWithDuplicate,
        unchangedPlan(currentWithDuplicate, [control, validRoot, invalidFirst]),
      );
    }).not.toThrow();
  });

  it('rejects missing and scope-shifted active body roots', () => {
    const current = loopCheckpoint(1);
    const control = current.invocations[0];
    const root = current.invocations[1];
    if (control === undefined || root === undefined)
      throw new Error('missing active loop fixture rows');
    expect(() => {
      validateTransitionDelta(current, unchangedPlan(current, [control]));
    }).toThrow();
    expect(() => {
      validateTransitionDelta(
        current,
        unchangedPlan(current, [{ ...root, branchPath: [] }, control]),
      );
    }).toThrow();
  });
});
