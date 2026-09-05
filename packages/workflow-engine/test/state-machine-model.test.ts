import { describe, expect, it } from 'vitest';

import { createCheckpoint } from '../src/index.js';
import {
  advanceWorkflow,
  type SchedulerGraph,
  type WorkflowObservation,
} from '../src/testing.js';

const NODE_IDS = ['a', 'b', 'c', 'd'] as const;
const POSSIBLE_EDGES = NODE_IDS.flatMap((source, sourceIndex) =>
  NODE_IDS.slice(sourceIndex + 1).map((target) => ({ source, target })),
);

function graphForMask(mask: number): SchedulerGraph {
  return {
    deriveReadiness: true,
    nodes: NODE_IDS.map((id) => ({ id, sideEffectClass: 'safe' })),
    edges: POSSIBLE_EDGES.flatMap(({ source, target }, index) =>
      (mask & (1 << index)) === 0
        ? []
        : [{ source: { nodeId: source }, target: { nodeId: target } }],
    ),
    structuredBodies: [],
  };
}

describe('bounded workflow state-machine model', () => {
  it('exhaustively preserves deterministic and monotonic transition invariants for every four-node DAG', () => {
    for (let mask = 0; mask < 1 << POSSIBLE_EDGES.length; mask += 1) {
      const schedulerState = graphForMask(mask);
      let checkpoint = createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        iterationBudget: 16,
      });
      const admitted = new Set<string>();
      let previousSequence = checkpoint.nextEventSequence;

      for (let turn = 0; turn <= NODE_IDS.length; turn += 1) {
        const observations: WorkflowObservation[] = checkpoint.invocations
          .filter(({ status }) => status === 'running')
          .map(({ invocationKey }) => ({
            kind: 'outcome',
            invocationKey,
            status: 'succeeded',
          }));
        const input = {
          checkpoint,
          schedulerState,
          observations,
          occurredAt: '2026-08-20T10:00:00.000Z',
          maximumAdmissions: NODE_IDS.length,
        } as const;
        const first = advanceWorkflow(input);
        expect(advanceWorkflow(input), `DAG mask ${String(mask)}`).toEqual(
          first,
        );
        expect(
          first.events.map(({ sequence }) => sequence),
          `DAG mask ${String(mask)} event sequence`,
        ).toEqual(
          Array.from(
            { length: first.events.length },
            (_, index) => previousSequence + index,
          ),
        );
        previousSequence += first.events.length;
        for (const attempt of first.attempts) {
          expect(
            admitted.has(attempt.invocationKey),
            `DAG mask ${String(mask)} duplicate admission`,
          ).toBe(false);
          admitted.add(attempt.invocationKey);
        }
        checkpoint = first.checkpoint;
        if (checkpoint.runStatus === 'succeeded') break;
      }

      expect(checkpoint.runStatus, `DAG mask ${String(mask)}`).toBe(
        'succeeded',
      );
      expect(admitted.size, `DAG mask ${String(mask)}`).toBe(NODE_IDS.length);
      expect(
        checkpoint.invocations.every(({ status }) => status === 'succeeded'),
        `DAG mask ${String(mask)}`,
      ).toBe(true);
    }
  });
});
