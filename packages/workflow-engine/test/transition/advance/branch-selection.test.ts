import { describe, expect, it } from 'vitest';
import { invocationKey } from '../../../src/index.js';
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
  it('scopes branch selections by exact local invocation identity', () => {
    const graph = {
      deriveReadiness: true as const,
      nodes: [
        {
          id: 'condition',
          definition: { key: 'core.condition', version: 1 },
          sideEffectClass: 'safe' as const,
        },
        { id: 'selected', sideEffectClass: 'safe' as const },
        { id: 'unselected', sideEffectClass: 'safe' as const },
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
    };
    const iterationPath = [{ loopNodeId: 'loop', ordinal: 0 }] as const;
    const rootKey = invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000004',
      nodeId: 'condition',
    });
    const bodyKey = invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000004',
      nodeId: 'condition',
      iterationPath,
    });
    const invocations = [
      {
        invocationKey: rootKey,
        nodeId: 'condition',
        status: 'succeeded' as const,
        attemptNumber: 1,
        output: {
          kind: 'inline' as const,
          attemptId: '00000000-0000-4000-8000-000000000204',
        },
      },
      {
        invocationKey: bodyKey,
        nodeId: 'condition',
        status: 'succeeded' as const,
        attemptNumber: 1,
        output: {
          kind: 'inline' as const,
          attemptId: '00000000-0000-4000-8000-000000000205',
        },
        iterationPath,
      },
    ];
    const branchSelections = [
      {
        invocationKey: rootKey,
        nodeId: 'condition',
        selectedOutputPort: 'true',
      },
      {
        invocationKey: bodyKey,
        nodeId: 'condition',
        selectedOutputPort: 'false',
      },
    ];

    expect(
      deriveReadyNodes({
        graph,
        workflowVersionId: '00000000-0000-4000-8000-000000000004',
        invocations,
        branchSelections,
      }).find(({ nodeId }) => nodeId === 'selected'),
    ).toMatchObject({ disposition: 'ready' });
    expect(
      deriveReadyNodes({
        graph,
        workflowVersionId: '00000000-0000-4000-8000-000000000004',
        invocations,
        branchSelections,
        iterationPath,
      }).find(({ nodeId }) => nodeId === 'unselected'),
    ).toMatchObject({ disposition: 'ready' });
  });
});
