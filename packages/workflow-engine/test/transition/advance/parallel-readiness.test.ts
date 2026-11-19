import { describe, expect, it } from 'vitest';
import { invocationKey } from '../../../src/server.js';
import { deriveReadyNodes } from '../../support/engine.js';

describe('AdvanceWorkflow branching', () => {
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
});
