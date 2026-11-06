import { expect, it } from 'vitest';
import {
  buildWorkflowExecutable,
  advanceWorkflow,
  createCheckpoint,
  parseCheckpoint,
  composeExecutableCatalog,
} from '../../../src/index.js';
import { graph, nodeCatalog } from '../../support/executable-workflow.js';

function nestedConditions(ids: readonly string[]) {
  const base = graph();
  const nodes = [
    base.nodes[0],
    ...ids.map((id) => ({
      ...base.nodes[1],
      id,
      definition: { key: 'core.condition', version: 1 },
      inputMappings: { condition: { kind: 'literal', value: true } },
    })),
    { ...base.nodes[1], id: 'leaf' },
  ];
  return {
    settings: {},
    nodes,
    edges: nodes.slice(1).map((node, n) => ({
      id: `edge-${String(n)}`,
      source: { nodeId: nodes[n]?.id ?? '', port: n === 0 ? 'out' : 'true' },
      target: { nodeId: node.id, port: 'in' },
    })),
  };
}

it('refuses nested scopes that cannot fit the persisted invocation identity before publication', () => {
  const ids = Array.from(
    { length: 7 },
    (_, n) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
  );
  expect(() =>
    buildWorkflowExecutable({
      graph: nestedConditions(ids),
      catalog: composeExecutableCatalog(nodeCatalog({ condition: true })),
    }),
  ).toThrow(/256.*identity|identity.*256/u);
});

it('counts encoded Unicode in persisted identities before publication', () => {
  expect(() =>
    buildWorkflowExecutable({
      graph: nestedConditions(['é'.repeat(64)]),
      catalog: composeExecutableCatalog(nodeCatalog({ condition: true })),
    }),
  ).toThrow(/256.*identity|identity.*256/u);
});

it.each([53, 54, 55])(
  'enforces the encoded 255/256/257-character boundary (step ID length %i)',
  async (length) => {
    const draft = nestedConditions([
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(length),
    ]);
    const compile = () =>
      buildWorkflowExecutable({
        graph: draft,
        catalog: composeExecutableCatalog(nodeCatalog({ condition: true })),
      });
    if (length === 55) expect(compile).toThrow(/identity.*256|256.*identity/u);
    else {
      const executable = compile();
      const workflowVersionId = '00000000-0000-4000-8000-000000000001';
      const base = {
        executable,
        workflowVersionId,
        runId: 'scope-capacity',
        occurredAt: '2026-11-06T12:00:00.000Z',
        maximumAdmissions: 200,
        signal: new AbortController().signal,
      };
      let plan = await advanceWorkflow({
        ...base,
        checkpoint: createCheckpoint({ workflowVersionId, iterationBudget: 0 }),
        observations: [],
      });
      for (let turn = 0; plan.attempts.length > 0 && turn < 10; turn++) {
        const outcomes = plan.attempts.map((attempt, n) => {
          const attemptId = `00000000-0000-4000-8000-${String(turn * 200 + n + 1).padStart(12, '0')}`;
          return {
            attempt,
            attemptId,
            sequence: plan.checkpoint.nextEventSequence + n,
          };
        });
        plan = await advanceWorkflow({
          ...base,
          checkpoint: parseCheckpoint(
            JSON.parse(JSON.stringify(plan.checkpoint)),
          ),
          observations: outcomes.map(({ attempt, attemptId, sequence }) => ({
            kind: 'outcome',
            sequence,
            occurredAt: base.occurredAt,
            invocationKey: attempt.invocationKey,
            attemptId,
            attemptNumber: 1,
            status: 'succeeded',
            output: { kind: 'inline', attemptId },
          })),
          completedOutputs: outcomes.map(
            ({ attempt, attemptId, sequence }) => ({
              sequence,
              attemptId,
              invocationKey: attempt.invocationKey,
              value:
                attempt.nodeId === 'manual' || attempt.nodeId === 'leaf'
                  ? {}
                  : { selectedPort: 'true' },
            }),
          ),
        });
      }
      expect(plan.checkpoint.runStatus).toBe('succeeded');
      expect(
        plan.checkpoint.invocations.find((node) => node.nodeId === 'leaf')
          ?.invocationKey,
      ).toHaveLength(202 + length);
    }
  },
);

it('refuses a wide retained frontier even when its individual identity keys fit', () => {
  const nested = nestedConditions(
    Array.from({ length: 12 }, (_, n) => `c${String(n)}`),
  );
  const base = graph();
  const leaves = Array.from({ length: 187 }, (_, n) => ({
    ...base.nodes[1],
    id: `leaf-${String(n)}`.padEnd(64, '-'),
  }));
  const draft = {
    ...nested,
    nodes: [...nested.nodes.slice(0, -1), ...leaves],
    edges: [
      ...nested.edges.slice(0, -1),
      ...leaves.map((node, n) => ({
        id: `tail-${String(n)}`,
        source: { nodeId: 'c11', port: 'true' },
        target: { nodeId: node.id, port: 'in' },
      })),
    ],
  };
  expect(() =>
    buildWorkflowExecutable({
      graph: draft,
      catalog: composeExecutableCatalog(nodeCatalog({ condition: true })),
    }),
  ).toThrow(/checkpoint capacity/u);
});
