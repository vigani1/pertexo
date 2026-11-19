import { describe, expect, it } from 'vitest';
import { invocationKey } from '../../../src/server.js';
import {
  advanceWorkflow as advanceWorkflowForTesting,
  deriveReadyNodes,
  parseSchedulerGraph,
} from '../../support/engine.js';
import {
  chainGraph,
  checkpoint,
  occurredAt,
} from '../../support/advance-workflow.js';
describe('AdvanceWorkflow branching', () => {
  it('retains edge ports in the scheduler projection', () => {
    expect(parseSchedulerGraph(chainGraph).edges).toEqual([
      {
        source: { nodeId: 'a', port: 'output' },
        target: { nodeId: 'b', port: 'input' },
      },
    ]);
  });
  it('rejects attempt admission without explicit scheduler state', () => {
    expect(() =>
      advanceWorkflowForTesting({
        checkpoint: checkpoint(),
        occurredAt,
        maximumAdmissions: 1,
        observations: [
          { kind: 'ready', invocationKey: 'node', nodeId: 'node' },
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'checkpoint_invalid',
        message: 'scheduler state is required for attempt admission',
      }),
    );
  });
  it('uses ordinal node ordering for deterministic admissions', () => {
    expect(
      deriveReadyNodes({
        graph: {
          deriveReadiness: true,
          nodes: [
            { id: 'a', sideEffectClass: 'safe' },
            { id: 'Z', sideEffectClass: 'safe' },
          ],
          edges: [],
        },
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        invocations: [],
      }).map(({ nodeId }) => nodeId),
    ).toEqual(['Z', 'a']);
  });
  it.each([false, true])(
    'derives Condition readiness and skips inside an inherited branch: %s',
    (nested) => {
      const inherited = nested
        ? [{ nodeId: 'outer', outputPort: 'branch-01' }]
        : [];
      const encoded = inherited.map(
        ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
      );
      const conditionKey = invocationKey({
        workflowVersionId: '00000000-0000-4000-8000-000000000002',
        nodeId: 'condition',
        branchPath: encoded,
      });

      expect(
        deriveReadyNodes({
          graph: {
            deriveReadiness: true,
            nodes: [
              {
                id: 'condition',
                definition: { key: 'core.condition', version: 1 },
                sideEffectClass: 'safe',
              },
              { id: 'selected', sideEffectClass: 'safe' },
              { id: 'unselected', sideEffectClass: 'safe' },
            ],
            edges: [
              {
                source: { nodeId: 'condition', port: 'true' },
                target: { nodeId: 'selected', port: 'in' },
              },
              {
                source: { nodeId: 'condition', port: 'false' },
                target: { nodeId: 'unselected', port: 'in' },
              },
            ],
          },
          workflowVersionId: '00000000-0000-4000-8000-000000000002',
          invocations: [
            {
              invocationKey: conditionKey,
              nodeId: 'condition',
              status: 'succeeded',
              branchPath: inherited,
              attemptNumber: 1,
              output: {
                kind: 'inline',
                attemptId: '00000000-0000-4000-8000-000000000101',
              },
            },
          ],
          branchSelections: [
            {
              invocationKey: conditionKey,
              nodeId: 'condition',
              selectedOutputPort: 'true',
            },
          ],
        }),
      ).toEqual([
        {
          invocationKey: invocationKey({
            workflowVersionId: '00000000-0000-4000-8000-000000000002',
            nodeId: 'selected',
            branchPath: [...encoded, 'condition:true'],
          }),
          nodeId: 'selected',
          disposition: 'ready',
          branchPath: [
            ...inherited,
            { nodeId: 'condition', outputPort: 'true' },
          ],
        },
        {
          invocationKey: invocationKey({
            workflowVersionId: '00000000-0000-4000-8000-000000000002',
            nodeId: 'unselected',
            branchPath: [...encoded, 'condition:false'],
          }),
          nodeId: 'unselected',
          disposition: 'skipped',
          branchPath: [
            ...inherited,
            { nodeId: 'condition', outputPort: 'false' },
          ],
        },
      ]);
    },
  );
});
