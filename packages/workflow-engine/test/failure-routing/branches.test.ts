import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@pertexo/workflow-model';

import type {
  WorkflowCheckpoint,
  WorkflowTransitionPlan,
} from '../../src/index.js';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  invocationKey,
} from '../../src/server.js';
import { graph, nodeCatalog } from '../support/executable-workflow.js';
import { version, at, id } from '../support/failure-routing-engine.js';

const scopedKey = (nodeId: string, branchPath: readonly string[] = []) =>
  invocationKey({ workflowVersionId: version, nodeId, branchPath });

/**
 * manual -> each Condition in turn on `true`, then charge -> done, with
 * charge's failure handled by refund -> refunded; every `false` declines.
 */
function branchedWorkflow(conditions: readonly string[]) {
  const [manual, set, terminate] = graph().nodes;
  const chain = ['manual', ...conditions, 'charge'];
  const routed: WorkflowGraph = {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      manual,
      ...conditions.flatMap((condition) => [
        {
          ...set,
          id: condition,
          definition: { key: 'core.condition', version: 1 },
          inputMappings: {
            condition: { kind: 'literal' as const, value: true },
          },
        },
        { ...terminate, id: `${condition}-declined`, inputMappings: {} },
      ]),
      { ...set, id: 'charge' },
      { ...terminate, id: 'done', inputMappings: {} },
      {
        ...set,
        id: 'refund',
        inputMappings: {
          reason: {
            kind: 'node_failure',
            nodeId: 'charge',
            path: '$.safeErrorCode',
          },
        },
      },
      { ...terminate, id: 'refunded', inputMappings: {} },
    ],
    edges: [
      ...chain.slice(1).map((target, index) => {
        const source = chain[index] ?? '';
        return [source, source === 'manual' ? 'out' : 'true', target];
      }),
      ...conditions.map((condition) => [
        condition,
        'false',
        `${condition}-declined`,
      ]),
      ['charge', 'out', 'done'],
      ['charge', '__failure', 'refund'],
      ['refund', 'out', 'refunded'],
    ].map(([source = '', port = '', target = '']) => ({
      id: `${source}-${port}-${target}`,
      source: { nodeId: source, port },
      target: { nodeId: target, port: 'in' },
    })),
  };
  return buildWorkflowExecutable({
    graph: routed,
    catalog: composeExecutableCatalog(nodeCatalog({ condition: true })),
  });
}

function run(conditions: readonly string[]) {
  const executable = branchedWorkflow(conditions);
  let checkpoint: WorkflowCheckpoint = createCheckpoint({
    workflowVersionId: version,
    iterationBudget: 100,
  });
  const advance = (
    from: WorkflowCheckpoint,
    observations: unknown[] = [],
    completedOutputs: unknown[] = [],
  ): Promise<WorkflowTransitionPlan> =>
    advanceWorkflow({
      runId: id,
      executable,
      workflowVersionId: version,
      checkpoint: from,
      observations,
      completedOutputs,
      occurredAt: at,
      maximumAdmissions: 5,
      signal: new AbortController().signal,
    });
  async function step(
    observations: unknown[] = [],
    completedOutputs: unknown[] = [],
  ) {
    const plan = await advance(checkpoint, observations, completedOutputs);
    checkpoint = plan.checkpoint;
    return plan;
  }
  function success(key: string, value?: unknown) {
    const sequence = checkpoint.nextEventSequence;
    return step(
      [
        {
          sequence,
          occurredAt: at,
          kind: 'outcome',
          invocationKey: key,
          status: 'succeeded',
          output: { kind: 'inline', attemptId: id },
          attemptId: id,
          attemptNumber: 1,
        },
      ],
      value === undefined
        ? []
        : [{ sequence, attemptId: id, invocationKey: key, value }],
    );
  }
  function fail(key: string) {
    return step([
      {
        occurredAt: at,
        kind: 'attempt_failure',
        invocationKey: key,
        attemptId: id,
        attemptNumber: 1,
        failureKind: 'failed',
        errorKind: 'authentication',
        possiblyDispatched: false,
        safeErrorCode: 'execution.authentication',
      },
    ]);
  }
  return { step, success, fail, advance };
}

/** Each Condition chooses `true`, then the charge in the innermost branch fails. */
async function chargeFailedInsideBranches(conditions: readonly string[]) {
  const r = run(conditions);
  await r.step();
  await r.success(scopedKey('manual'));
  const branchPath: string[] = [];
  for (const condition of conditions) {
    await r.success(scopedKey(condition, branchPath), { selectedPort: 'true' });
    branchPath.push(`${condition}:true`);
  }
  const key = (nodeId: string) => scopedKey(nodeId, branchPath);
  return { r, key, routed: await r.fail(key('charge')) };
}

describe.each([
  ['one Condition', ['condition']],
  ['nested Conditions', ['outer', 'inner']],
])('failure routes inside %s', (_scope, conditions) => {
  it('runs the handler in the branch the Conditions selected and succeeds once it finishes', async () => {
    const { r, key, routed } = await chargeFailedInsideBranches(conditions);

    expect(routed.attempts.map((a) => a.invocationKey)).toEqual([
      key('refund'),
    ]);
    expect(routed.failureValues).toEqual([
      {
        entryInvocationKey: key('refund'),
        value: {
          nodeId: 'charge',
          invocationKey: key('charge'),
          attemptNumber: 1,
          errorKind: 'authentication',
          safeErrorCode: 'execution.authentication',
        },
      },
    ]);
    expect(routed.checkpoint.runStatus).toBe('running');

    await r.success(key('refund'));
    const finished = await r.success(key('refunded'));
    expect(finished.checkpoint.runStatus).toBe('succeeded');
    expect(
      finished.checkpoint.invocations.find(
        (n) => n.invocationKey === key('charge'),
      )?.failureHandling,
    ).toEqual({ sinkInvocationKey: key('refunded'), disposition: 'handled' });
  });

  it('refuses a checkpoint whose routed failure sits in a branch a Condition did not choose', async () => {
    const { r, routed } = await chargeFailedInsideBranches(conditions);
    await expect(r.advance(routed.checkpoint)).resolves.toMatchObject({
      checkpoint: { runStatus: 'running' },
    });
    const innermost = conditions.at(-1);
    await expect(
      r.advance({
        ...routed.checkpoint,
        branchSelections: routed.checkpoint.branchSelections.map((selection) =>
          selection.nodeId === innermost
            ? { ...selection, selectedOutputPort: 'false' }
            : selection,
        ),
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
  });

  it.each(['failed', 'running', 'missing'] as const)(
    'refuses a checkpoint that calls the failure handled while its handler step is %s',
    async (handler) => {
      const { r, key } = await chargeFailedInsideBranches(conditions);
      await r.success(key('refund'));
      const { checkpoint } = await r.success(key('refunded'));
      const handledMidRun = { ...checkpoint, runStatus: 'running' as const };
      await expect(r.advance(handledMidRun)).resolves.toMatchObject({
        checkpoint: { runStatus: 'succeeded' },
      });
      const tampered =
        handler === 'missing'
          ? {
              ...handledMidRun,
              admittedInvocationKeys: checkpoint.admittedInvocationKeys.filter(
                (admitted) => admitted !== key('refund'),
              ),
              invocations: checkpoint.invocations.filter(
                ({ nodeId }) => nodeId !== 'refund',
              ),
            }
          : structuredClone(handledMidRun);
      if (handler !== 'missing')
        Object.assign(
          tampered.invocations.find(({ nodeId }) => nodeId === 'refund') ?? {},
          { status: handler },
        );
      await expect(r.advance(tampered)).rejects.toMatchObject({
        code: 'workflow_identity_invalid',
      });
    },
  );
});
