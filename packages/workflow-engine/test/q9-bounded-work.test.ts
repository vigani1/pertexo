import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import {
  parseCheckpoint,
  WORKFLOW_CHECKPOINT_LIMITS_V1,
} from '../src/index.js';

const workflowVersionId = '00000000-0000-4000-8000-000000000001';

function checkpoint(population: number) {
  return {
    schemaVersion: 1,
    engineVersion: 'engine-v1',
    workflowVersionId,
    revision: 0,
    runStatus: 'running',
    nextEventSequence: 1,
    readySet: [],
    admittedInvocationKeys: [],
    invocations: Array.from({ length: population }, (_, index) => ({
      invocationKey: `invocation-${String(index)}`,
      nodeId: `node-${String(index)}`,
      status: 'pending',
      attemptNumber: 0,
    })),
    joins: [],
    loops: [],
    remainingIterationBudget: 0,
    cancelRequested: false,
    deadlineExpired: false,
  };
}

function largestAcceptedPopulation(): number {
  let accepted = 0;
  let rejected = WORKFLOW_CHECKPOINT_LIMITS_V1.arrayItems + 1;
  while (accepted + 1 < rejected) {
    const candidate = Math.floor((accepted + rejected) / 2);
    try {
      parseCheckpoint(checkpoint(candidate));
      accepted = candidate;
    } catch {
      rejected = candidate;
    }
  }
  return accepted;
}

describe('Q9 workflow-engine bounded-work consumer', () => {
  it('parses small, intermediate and effective-upper checkpoint populations', () => {
    const upperSupportedPopulation = largestAcceptedPopulation();
    expect(upperSupportedPopulation).toBeGreaterThan(1);
    for (const population of [
      1,
      Math.ceil(upperSupportedPopulation / 2),
      upperSupportedPopulation,
    ]) {
      const setupStarted = performance.now();
      const input = checkpoint(population);
      const setupMs = performance.now() - setupStarted;
      const heapBefore = process.memoryUsage().heapUsed;
      const started = performance.now();
      const parsed = parseCheckpoint(input);
      const operationMs = performance.now() - started;
      const processHeapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
      expect(parsed.invocations).toHaveLength(population);
      console.info(
        `Q9_BOUNDED_WORK_V1=${JSON.stringify({
          schemaVersion: 1,
          family: 'workflow-engine-checkpoint-validation-projection',
          contractVersion: 'workflow-engine-checkpoint-v1',
          population,
          upperSupportedPopulation,
          completedOperations: parsed.invocations.length,
          setupMs,
          operationMs,
          attributableMemory: {
            available: false,
            reason:
              'The probe shares a Vitest process and garbage collector; process heap delta is diagnostic, not attributable workload memory.',
            processHeapDeltaBytes,
          },
        })}`,
      );
    }
  });
});
