import { describe, expect, it } from 'vitest';
import { createCheckpoint, invocationKey } from '../../../src/index.js';
import {
  advanceWorkflow as advanceWorkflowForTesting,
  deriveReadyNodes,
} from '../../support/engine.js';
import { occurredAt } from '../../support/advance-workflow.js';
describe('AdvanceWorkflow branching', () => {
  it('bounds Parallel attempt admissions below the run-wide admission cap', () => {
    const branchKeys = ['branch-01', 'branch-02'].map((port) =>
      invocationKey({
        workflowVersionId: '00000000-0000-4000-8000-000000000003',
        nodeId: port,
        branchPath: [`parallel:${port}`],
      }),
    );
    const plan = advanceWorkflowForTesting({
      checkpoint: {
        ...createCheckpoint({
          workflowVersionId: '00000000-0000-4000-8000-000000000003',
          iterationBudget: 0,
        }),
        runStatus: 'running',
        readySet: branchKeys,
        invocations: [
          {
            invocationKey: invocationKey({
              workflowVersionId: '00000000-0000-4000-8000-000000000003',
              nodeId: 'parallel',
            }),
            nodeId: 'parallel',
            status: 'succeeded' as const,
            attemptNumber: 1,
            output: {
              kind: 'inline' as const,
              attemptId: '00000000-0000-4000-8000-000000000105',
            },
          },
          ...branchKeys.map((invocationKey, index) => ({
            invocationKey,
            nodeId: `branch-0${String(index + 1)}`,
            status: 'ready' as const,
            attemptNumber: 0,
            branchPath: [
              {
                nodeId: 'parallel',
                outputPort: `branch-0${String(index + 1)}`,
              },
            ],
          })),
        ],
      },
      schedulerState: {
        deriveReadiness: true,
        nodes: [
          {
            id: 'parallel',
            definition: { key: 'core.parallel', version: 1 },
            control: {
              kind: 'parallel',
              config: {
                branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
                maxConcurrency: 1,
              },
            },
            sideEffectClass: 'safe',
          },
          { id: 'branch-01', sideEffectClass: 'safe' },
          { id: 'branch-02', sideEffectClass: 'safe' },
        ],
        edges: [],
      },
      occurredAt,
      maximumAdmissions: 10,
    });

    expect(plan.attempts).toHaveLength(1);
    expect(plan.checkpoint.readySet).toHaveLength(1);
  });
  it('rejects branch selections outside the pinned Condition contract', () => {
    const conditionKey = invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000002',
      nodeId: 'condition',
    });
    expect(() =>
      deriveReadyNodes({
        graph: {
          deriveReadiness: true,
          nodes: [
            {
              id: 'condition',
              definition: { key: 'core.set', version: 1 },
              sideEffectClass: 'safe',
            },
          ],
          edges: [],
        },
        workflowVersionId: '00000000-0000-4000-8000-000000000002',
        invocations: [
          {
            invocationKey: conditionKey,
            nodeId: 'condition',
            status: 'succeeded',
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
    ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
  });
  it('persists selected and skipped Condition branches in checkpoint', () => {
    const conditionKey = invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000002',
      nodeId: 'condition',
    });
    const plan = advanceWorkflowForTesting({
      checkpoint: {
        ...createCheckpoint({
          workflowVersionId: '00000000-0000-4000-8000-000000000002',
          iterationBudget: 1_000,
        }),
        revision: 1,
        runStatus: 'running',
        admittedInvocationKeys: [conditionKey],
        invocations: [
          {
            invocationKey: conditionKey,
            nodeId: 'condition',
            status: 'succeeded',
            attemptNumber: 1,
            output: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000101',
            },
          },
        ],
        branchSelections: [],
      },
      schedulerState: {
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
      occurredAt,
      maximumAdmissions: 2,
      observations: [
        {
          kind: 'branch_selected',
          invocationKey: conditionKey,
          nodeId: 'condition',
          selectedOutputPort: 'true',
        },
      ],
    });

    expect(plan.checkpoint).toMatchObject({
      branchSelections: [
        {
          invocationKey: conditionKey,
          nodeId: 'condition',
          selectedOutputPort: 'true',
        },
      ],
      invocations: [
        { nodeId: 'condition', status: 'succeeded' },
        {
          nodeId: 'selected',
          status: 'running',
          branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
        },
        {
          nodeId: 'unselected',
          status: 'skipped',
          branchPath: [{ nodeId: 'condition', outputPort: 'false' }],
        },
      ],
    });
    expect(plan.nodeRunAdmissions.map(({ nodeId }) => nodeId)).toEqual([
      'selected',
      'unselected',
    ]);
    expect(plan.attempts.map(({ nodeId }) => nodeId)).toEqual(['selected']);
  });
});
