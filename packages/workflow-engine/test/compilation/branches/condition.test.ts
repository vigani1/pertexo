import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  invocationKey,
} from '../../../src/index.js';
import {
  nodeCatalog,
  conditionGraph,
  graph,
} from '../../support/executable-workflow.js';
describe('branching production operations', () => {
  it('advances only through the verified executable graph and rejects malformed observations', async () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const executable = buildWorkflowExecutable({ graph: graph(), catalog });
    const checkpoint = createCheckpoint({
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      iterationBudget: 0,
    });
    const first = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint,
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    expect(first.attempts.map(({ nodeId }) => nodeId)).toEqual(['manual']);
    const foreignCheckpoint = structuredClone(first.checkpoint);
    Object.assign(foreignCheckpoint.invocations[0] ?? {}, { nodeId: 'set' });
    await expect(
      advanceWorkflow({
        runId: 'run-1',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint: foreignCheckpoint,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
    expect(
      await advanceWorkflow({
        runId: 'run-1',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [],
        signal: new AbortController().signal,
      }),
    ).toEqual(first);
    await expect(
      advanceWorkflow({
        runId: 'run-1',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [{ kind: 'loop_started' }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    await expect(
      advanceWorkflow({
        runId: 'run-1',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000002',
        checkpoint,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
    await expect(
      advanceWorkflow({
        runId: 'run-1',
        executable: {
          envelope: executable.envelope,
          checksum: executable.checksum,
        },
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'executable_invalid' });
  });
  it('accepts canonical branch-scoped checkpoint identity', async () => {
    const workflowVersionId = '00000000-0000-4000-8000-000000000007';
    const catalog = composeExecutableCatalog(nodeCatalog({ condition: true }));
    const executable = buildWorkflowExecutable({
      graph: conditionGraph('true'),
      catalog,
    });
    const conditionKey = invocationKey({
      workflowVersionId,
      nodeId: 'condition',
    });
    const terminateKey = invocationKey({
      workflowVersionId,
      nodeId: 'terminate',
      branchPath: ['condition:true'],
    });
    const checkpoint = {
      ...createCheckpoint({
        workflowVersionId,
        iterationBudget: 0,
      }),
      revision: 1,
      runStatus: 'running',
      readySet: [terminateKey],
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
        {
          invocationKey: terminateKey,
          nodeId: 'terminate',
          status: 'ready',
          attemptNumber: 0,
          branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
        },
      ],
      branchSelections: [
        {
          invocationKey: conditionKey,
          nodeId: 'condition',
          selectedOutputPort: 'true',
        },
      ],
    } as const;

    await expect(
      advanceWorkflow({
        runId: 'run-condition',
        executable,
        workflowVersionId,
        checkpoint,
        occurredAt: '2026-08-24T00:00:00.000Z',
        maximumAdmissions: 0,
        observations: [],
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ checkpoint: {} });

    for (const branchPath of [
      [{ nodeId: 'missing', outputPort: 'true' }],
      [{ nodeId: 'condition', outputPort: 'missing' }],
    ]) {
      const invalidBranchScope = structuredClone(checkpoint);
      const invalidInvocationKey = invocationKey({
        workflowVersionId,
        nodeId: 'terminate',
        branchPath: branchPath.map(
          ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
        ),
      });
      Object.assign(invalidBranchScope.invocations[1], {
        branchPath,
        invocationKey: invalidInvocationKey,
      });
      Object.assign(invalidBranchScope, { readySet: [invalidInvocationKey] });
      await expect(
        advanceWorkflow({
          runId: 'run-condition',
          executable,
          workflowVersionId,
          checkpoint: invalidBranchScope,
          occurredAt: '2026-08-24T00:00:00.000Z',
          maximumAdmissions: 0,
          observations: [],
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
    }
  });
  it('derives a Condition selection only from its persisted inline output', async () => {
    const workflowVersionId = '00000000-0000-4000-8000-000000000007';
    const catalog = composeExecutableCatalog(nodeCatalog({ condition: true }));
    const condition = conditionGraph('true');
    const executable = buildWorkflowExecutable({
      graph: {
        ...condition,
        nodes: [
          ...condition.nodes,
          { ...condition.nodes[2], id: 'false-terminate' },
        ],
        edges: [
          ...condition.edges,
          {
            id: 'condition-false-terminate',
            source: { nodeId: 'condition', port: 'false' },
            target: { nodeId: 'false-terminate', port: 'in' },
          },
        ],
      },
      catalog,
    });
    const manualKey = invocationKey({ workflowVersionId, nodeId: 'manual' });
    const conditionKey = invocationKey({
      workflowVersionId,
      nodeId: 'condition',
    });
    const attemptId = '00000000-0000-4000-8000-000000000102';
    const checkpoint = {
      ...createCheckpoint({
        workflowVersionId,
        iterationBudget: 0,
      }),
      runStatus: 'running',
      admittedInvocationKeys: [conditionKey, manualKey],
      invocations: [
        {
          invocationKey: manualKey,
          nodeId: 'manual',
          status: 'succeeded',
          attemptNumber: 1,
        },
        {
          invocationKey: conditionKey,
          nodeId: 'condition',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    } as const;

    const plan = await advanceWorkflow({
      runId: 'run-condition',
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
          invocationKey: conditionKey,
          status: 'succeeded',
          output: { kind: 'inline', attemptId },
        },
      ],
      completedOutputs: [
        {
          sequence: 2,
          attemptId,
          invocationKey: conditionKey,
          value: { selectedPort: 'true' },
        },
      ],
      occurredAt: '2026-08-24T00:00:01.000Z',
      maximumAdmissions: 1,
      signal: new AbortController().signal,
    });

    expect(plan.checkpoint).toMatchObject({
      branchSelections: [
        {
          invocationKey: conditionKey,
          nodeId: 'condition',
          selectedOutputPort: 'true',
        },
      ],
    });
    expect(plan.checkpoint.invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'terminate', status: 'running' }),
        expect.objectContaining({
          nodeId: 'false-terminate',
          status: 'skipped',
        }),
      ]),
    );
    expect(plan.attempts.map(({ nodeId }) => nodeId)).toEqual(['terminate']);
  });
});
