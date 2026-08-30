import { describe, expect, it } from 'vitest';

import {
  createCheckpoint,
  createCheckpointV2,
  invocationKey,
  type WorkflowCheckpointV1,
} from '../src/index.js';
import {
  advanceWorkflow as advanceWorkflowForTesting,
  deriveReadyNodes,
  parseSchedulerGraph,
} from '../src/testing.js';

const occurredAt = '2026-08-20T10:00:00.000Z';
const chainGraph = {
  schemaVersion: 1,
  settings: {},
  nodes: ['a', 'b'].map((id) => ({
    id,
    definition: { key: 'core.set', version: 1 },
    position: { x: 0, y: 0 },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
  })),
  edges: [
    {
      id: 'a-b',
      source: { nodeId: 'a', port: 'output' },
      target: { nodeId: 'b', port: 'input' },
    },
  ],
} as const;

function checkpoint(): WorkflowCheckpointV1 {
  return createCheckpoint({
    engineVersion: 'engine-v1',
    workflowVersionId: 'version-1',
    iterationBudget: 1_000,
  });
}

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
        workflowVersionId: 'version-1',
        invocations: [],
      }).map(({ nodeId }) => nodeId),
    ).toEqual(['Z', 'a']);
  });

  it('derives selected Condition readiness and explicit non-selected skips', () => {
    const conditionKey = invocationKey({
      workflowVersionId: 'version-2',
      nodeId: 'condition',
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
        workflowVersionId: 'version-2',
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
    ).toEqual([
      {
        invocationKey: invocationKey({
          workflowVersionId: 'version-2',
          nodeId: 'selected',
          branchPath: ['condition:true'],
        }),
        nodeId: 'selected',
        disposition: 'ready',
        branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
      },
      {
        invocationKey: invocationKey({
          workflowVersionId: 'version-2',
          nodeId: 'unselected',
          branchPath: ['condition:false'],
        }),
        nodeId: 'unselected',
        disposition: 'skipped',
        branchPath: [{ nodeId: 'condition', outputPort: 'false' }],
      },
    ]);
  });

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
      workflowVersionId: 'version-scoped',
      nodeId: 'condition',
    });
    const bodyKey = invocationKey({
      workflowVersionId: 'version-scoped',
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
        workflowVersionId: 'version-scoped',
        invocations,
        branchSelections,
      }).find(({ nodeId }) => nodeId === 'selected'),
    ).toMatchObject({ disposition: 'ready' });
    expect(
      deriveReadyNodes({
        graph,
        workflowVersionId: 'version-scoped',
        invocations,
        branchSelections,
        iterationPath,
      }).find(({ nodeId }) => nodeId === 'unselected'),
    ).toMatchObject({ disposition: 'ready' });
  });

  it('derives one selected Switch branch and skips every configured alternative', () => {
    const switchKey = invocationKey({
      workflowVersionId: 'version-switch',
      nodeId: 'switch',
    });

    expect(
      deriveReadyNodes({
        graph: {
          deriveReadiness: true,
          nodes: [
            {
              id: 'switch',
              definition: { key: 'core.switch', version: 1 },
              config: {
                cases: [
                  { id: 'case-02', equals: 'first' },
                  { id: 'case-01', equals: 'second' },
                ],
              },
              sideEffectClass: 'safe',
            },
            { id: 'selected', sideEffectClass: 'safe' },
            { id: 'unselected', sideEffectClass: 'safe' },
            { id: 'default', sideEffectClass: 'safe' },
          ],
          edges: [
            {
              source: { nodeId: 'switch', port: 'case-02' },
              target: { nodeId: 'selected', port: 'in' },
            },
            {
              source: { nodeId: 'switch', port: 'case-01' },
              target: { nodeId: 'unselected', port: 'in' },
            },
            {
              source: { nodeId: 'switch', port: 'default' },
              target: { nodeId: 'default', port: 'in' },
            },
          ],
        },
        workflowVersionId: 'version-switch',
        invocations: [
          {
            invocationKey: switchKey,
            nodeId: 'switch',
            status: 'succeeded',
            attemptNumber: 1,
            output: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000102',
            },
          },
        ],
        branchSelections: [
          {
            invocationKey: switchKey,
            nodeId: 'switch',
            selectedOutputPort: 'case-02',
          },
        ],
      }),
    ).toEqual([
      {
        invocationKey: invocationKey({
          workflowVersionId: 'version-switch',
          nodeId: 'default',
          branchPath: ['switch:default'],
        }),
        nodeId: 'default',
        disposition: 'skipped',
        branchPath: [{ nodeId: 'switch', outputPort: 'default' }],
      },
      {
        invocationKey: invocationKey({
          workflowVersionId: 'version-switch',
          nodeId: 'selected',
          branchPath: ['switch:case-02'],
        }),
        nodeId: 'selected',
        disposition: 'ready',
        branchPath: [{ nodeId: 'switch', outputPort: 'case-02' }],
      },
      {
        invocationKey: invocationKey({
          workflowVersionId: 'version-switch',
          nodeId: 'unselected',
          branchPath: ['switch:case-01'],
        }),
        nodeId: 'unselected',
        disposition: 'skipped',
        branchPath: [{ nodeId: 'switch', outputPort: 'case-01' }],
      },
    ]);
  });

  it('makes every declared Parallel branch ready with stable scope', () => {
    const parallelKey = invocationKey({
      workflowVersionId: 'version-parallel',
      nodeId: 'parallel',
    });
    expect(
      deriveReadyNodes({
        graph: {
          deriveReadiness: true,
          nodes: [
            {
              id: 'parallel',
              definition: { key: 'core.parallel', version: 1 },
              config: {
                branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
                maxConcurrency: 1,
              },
              sideEffectClass: 'safe',
            },
            { id: 'left', sideEffectClass: 'safe' },
            { id: 'right', sideEffectClass: 'safe' },
          ],
          edges: [
            {
              source: { nodeId: 'parallel', port: 'branch-02' },
              target: { nodeId: 'left', port: 'in' },
            },
            {
              source: { nodeId: 'parallel', port: 'branch-01' },
              target: { nodeId: 'right', port: 'in' },
            },
          ],
        },
        workflowVersionId: 'version-parallel',
        invocations: [
          {
            invocationKey: parallelKey,
            nodeId: 'parallel',
            status: 'succeeded',
            attemptNumber: 1,
            output: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000104',
            },
          },
        ],
      }),
    ).toEqual([
      {
        invocationKey: invocationKey({
          workflowVersionId: 'version-parallel',
          nodeId: 'left',
          branchPath: ['parallel:branch-02'],
        }),
        nodeId: 'left',
        disposition: 'ready',
        branchPath: [{ nodeId: 'parallel', outputPort: 'branch-02' }],
      },
      {
        invocationKey: invocationKey({
          workflowVersionId: 'version-parallel',
          nodeId: 'right',
          branchPath: ['parallel:branch-01'],
        }),
        nodeId: 'right',
        disposition: 'ready',
        branchPath: [{ nodeId: 'parallel', outputPort: 'branch-01' }],
      },
    ]);
  });

  it('bounds Parallel attempt admissions below the run-wide admission cap', () => {
    const branchKeys = ['branch-01', 'branch-02'].map((port) =>
      invocationKey({
        workflowVersionId: 'version-parallel',
        nodeId: port,
        branchPath: [`parallel:${port}`],
      }),
    );
    const plan = advanceWorkflowForTesting({
      checkpoint: {
        ...createCheckpointV2({
          engineVersion: 'engine-v2',
          workflowVersionId: 'version-parallel',
          iterationBudget: 0,
        }),
        runStatus: 'running',
        readySet: branchKeys,
        invocations: [
          {
            invocationKey: invocationKey({
              workflowVersionId: 'version-parallel',
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
            config: {
              branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
              maxConcurrency: 1,
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
      workflowVersionId: 'version-2',
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
        workflowVersionId: 'version-2',
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

  it('persists selected and skipped Condition branches in checkpoint V2', () => {
    const conditionKey = invocationKey({
      workflowVersionId: 'version-2',
      nodeId: 'condition',
    });
    const plan = advanceWorkflowForTesting({
      checkpoint: {
        ...createCheckpointV2({
          engineVersion: 'engine-v2',
          workflowVersionId: 'version-2',
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
      schemaVersion: 2,
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
