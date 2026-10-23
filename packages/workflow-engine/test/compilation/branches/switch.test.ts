import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  invocationKey,
} from '../../../src/index.js';
import { nodeCatalog, switchGraph } from '../../support/executable-workflow.js';
describe('branching production operations', () => {
  it('derives a Switch selection only from its persisted inline output', async () => {
    const workflowVersionId = '00000000-0000-4000-8000-000000000005';
    const catalog = composeExecutableCatalog(nodeCatalog({ switch: true }));
    const selected = switchGraph('case-02');
    const executable = buildWorkflowExecutable({
      graph: {
        ...selected,
        nodes: [
          ...selected.nodes,
          { ...selected.nodes[2], id: 'case-01-terminate' },
          { ...selected.nodes[2], id: 'default-terminate' },
        ],
        edges: [
          ...selected.edges,
          {
            id: 'switch-case-01-terminate',
            source: { nodeId: 'switch', port: 'case-01' },
            target: { nodeId: 'case-01-terminate', port: 'in' },
          },
          {
            id: 'switch-default-terminate',
            source: { nodeId: 'switch', port: 'default' },
            target: { nodeId: 'default-terminate', port: 'in' },
          },
        ],
      },
      catalog,
    });
    const manualKey = invocationKey({ workflowVersionId, nodeId: 'manual' });
    const switchKey = invocationKey({ workflowVersionId, nodeId: 'switch' });
    const attemptId = '00000000-0000-4000-8000-000000000103';
    const checkpoint = {
      ...createCheckpoint({
        workflowVersionId,
        iterationBudget: 0,
      }),
      runStatus: 'running',
      admittedInvocationKeys: [manualKey, switchKey],
      invocations: [
        {
          invocationKey: manualKey,
          nodeId: 'manual',
          status: 'succeeded',
          attemptNumber: 1,
        },
        {
          invocationKey: switchKey,
          nodeId: 'switch',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    } as const;

    const plan = await advanceWorkflow({
      runId: 'run-switch',
      executable,
      workflowVersionId,
      checkpoint,
      observations: [
        {
          sequence: 2,
          occurredAt: '2026-08-24T00:00:00.000Z',
          attemptId,
          attemptNumber: 1,
          kind: 'outcome',
          invocationKey: switchKey,
          status: 'succeeded',
          output: { kind: 'inline', attemptId },
        },
      ],
      completedOutputs: [
        {
          sequence: 2,
          attemptId,
          invocationKey: switchKey,
          value: { selectedPort: 'case-02' },
        },
      ],
      occurredAt: '2026-08-24T00:00:01.000Z',
      maximumAdmissions: 1,
      signal: new AbortController().signal,
    });

    expect(plan.checkpoint).toMatchObject({
      branchSelections: [
        {
          invocationKey: switchKey,
          nodeId: 'switch',
          selectedOutputPort: 'case-02',
        },
      ],
    });
    expect(plan.checkpoint.invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'terminate', status: 'running' }),
        expect.objectContaining({
          nodeId: 'case-01-terminate',
          status: 'skipped',
        }),
        expect.objectContaining({
          nodeId: 'default-terminate',
          status: 'skipped',
        }),
      ]),
    );
    expect(plan.attempts.map(({ nodeId }) => nodeId)).toEqual(['terminate']);
  });
});
