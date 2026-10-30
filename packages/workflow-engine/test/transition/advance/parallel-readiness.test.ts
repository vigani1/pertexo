import { describe, expect, it } from 'vitest';
import { invocationKey } from '../../../src/index.js';
import { deriveReadyNodes } from '../../support/engine.js';

describe('AdvanceWorkflow branching', () => {
  it('derives one selected Switch branch and skips every configured alternative', () => {
    const switchKey = invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000005',
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
              control: {
                kind: 'switch',
                config: {
                  cases: [
                    { id: 'case-02', equals: 'first' },
                    { id: 'case-01', equals: 'second' },
                  ],
                },
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
        workflowVersionId: '00000000-0000-4000-8000-000000000005',
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
          workflowVersionId: '00000000-0000-4000-8000-000000000005',
          nodeId: 'default',
          branchPath: ['switch:default'],
        }),
        nodeId: 'default',
        disposition: 'skipped',
        branchPath: [{ nodeId: 'switch', outputPort: 'default' }],
      },
      {
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000005',
          nodeId: 'selected',
          branchPath: ['switch:case-02'],
        }),
        nodeId: 'selected',
        disposition: 'ready',
        branchPath: [{ nodeId: 'switch', outputPort: 'case-02' }],
      },
      {
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000005',
          nodeId: 'unselected',
          branchPath: ['switch:case-01'],
        }),
        nodeId: 'unselected',
        disposition: 'skipped',
        branchPath: [{ nodeId: 'switch', outputPort: 'case-01' }],
      },
    ]);
  });
  it('blocks every conditional descendant until a durable selection exists', () => {
    const conditionKey = invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000006',
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
          ],
          edges: [
            {
              source: { nodeId: 'condition', port: 'true' },
              target: { nodeId: 'selected', port: 'in' },
            },
          ],
        },
        workflowVersionId: '00000000-0000-4000-8000-000000000006',
        invocations: [
          {
            invocationKey: conditionKey,
            nodeId: 'condition',
            status: 'succeeded',
            attemptNumber: 1,
            output: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000106',
            },
          },
        ],
      }),
    ).toEqual([]);
  });
  it('propagates skipped unpaired Parallel scope without inventing a Merge', () => {
    const branchPath = [] as const;
    const parallelKey = invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000007',
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
              control: {
                kind: 'parallel',
                config: {
                  branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
                  maxConcurrency: 1,
                },
              },
              sideEffectClass: 'safe',
            },
            { id: 'branch-one', sideEffectClass: 'safe' },
            { id: 'branch-two', sideEffectClass: 'safe' },
          ],
          edges: [
            {
              source: { nodeId: 'parallel', port: 'branch-01' },
              target: { nodeId: 'branch-one', port: 'in' },
            },
            {
              source: { nodeId: 'parallel', port: 'branch-02' },
              target: { nodeId: 'branch-two', port: 'in' },
            },
          ],
        },
        workflowVersionId: '00000000-0000-4000-8000-000000000007',
        invocations: [
          {
            invocationKey: parallelKey,
            nodeId: 'parallel',
            status: 'skipped',
            attemptNumber: 0,
          },
        ],
        branchPath,
      }),
    ).toEqual([
      {
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000007',
          nodeId: 'branch-one',
          branchPath: ['parallel:branch-01'],
        }),
        nodeId: 'branch-one',
        disposition: 'skipped',
        branchPath: [
          ...branchPath,
          { nodeId: 'parallel', outputPort: 'branch-01' },
        ],
      },
      {
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000007',
          nodeId: 'branch-two',
          branchPath: ['parallel:branch-02'],
        }),
        nodeId: 'branch-two',
        disposition: 'skipped',
        branchPath: [
          ...branchPath,
          { nodeId: 'parallel', outputPort: 'branch-02' },
        ],
      },
    ]);
  });
  it('makes every declared Parallel branch ready with stable scope', () => {
    const parallelKey = invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000003',
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
              control: {
                kind: 'parallel',
                config: {
                  branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
                  maxConcurrency: 1,
                },
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
        workflowVersionId: '00000000-0000-4000-8000-000000000003',
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
          workflowVersionId: '00000000-0000-4000-8000-000000000003',
          nodeId: 'left',
          branchPath: ['parallel:branch-02'],
        }),
        nodeId: 'left',
        disposition: 'ready',
        branchPath: [{ nodeId: 'parallel', outputPort: 'branch-02' }],
      },
      {
        invocationKey: invocationKey({
          workflowVersionId: '00000000-0000-4000-8000-000000000003',
          nodeId: 'right',
          branchPath: ['parallel:branch-01'],
        }),
        nodeId: 'right',
        disposition: 'ready',
        branchPath: [{ nodeId: 'parallel', outputPort: 'branch-01' }],
      },
    ]);
  });
});
