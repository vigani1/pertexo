import { parseCheckpoint } from '@pertexo/workflow-engine';

import { expect } from 'vitest';

import { workerQuery, workspaceId } from '../fixture.js';
import type { ForEachPhaseContext } from './contract.js';

export async function assertParallelLoopCompletion(
  context: ForEachPhaseContext,
) {
  const { accepted, eraseRedisAndRestart } = context;
  const { continueAfter, execute } = context.delivery;
  // A sink outcome survives worker/Redis loss before coordinator consumption.
  await eraseRedisAndRestart();
  await continueAfter(6);
  const laterBatch = await workerQuery<{ scheduler_state: unknown }>(
    `select scheduler_state from app.run_checkpoints
            where workspace_id=$1 and workflow_run_id=$2`,
    [workspaceId, accepted.runId],
  );
  expect(parseCheckpoint(laterBatch[0]?.scheduler_state)).toMatchObject({
    remainingIterationBudget: 997,
    loops: [
      {
        activeOrdinals: [2],
        nextOrdinal: 3,
        completedPrefix: 2,
        terminalOrdinals: [],
      },
    ],
  });
  await eraseRedisAndRestart();
  await execute('body-map', 2);
  await continueAfter(7);
  await execute('body-sink', 2);
  await continueAfter(8);
  await continueAfter(9);
  await execute('outer-successor');
  await continueAfter(10);

  const facts = await workerQuery<{
    branch_context: unknown;
    node_id: string;
    output_ref: unknown;
    scheduler_state: unknown;
    status: string;
  }>(
    `select node.node_id,node.status,node.branch_context,node.output_ref,
                  checkpoint.scheduler_state
             from app.node_runs node
             join app.run_checkpoints checkpoint
               on checkpoint.workflow_run_id=node.workflow_run_id
            where node.workspace_id=$1 and node.workflow_run_id=$2
            order by node.node_id,node.invocation_key`,
    [workspaceId, accepted.runId],
  );
  expect(parseCheckpoint(facts[0]?.scheduler_state)).toMatchObject({
    remainingIterationBudget: 997,
    runStatus: 'succeeded',
    loops: [
      {
        activeOrdinals: [],
        nextOrdinal: 3,
        completedPrefix: 3,
        terminalOrdinals: [],
      },
    ],
  });
  expect(
    facts
      .filter(({ node_id }) => node_id === 'body-map')
      .map(({ branch_context, output_ref }) => ({
        branch_context,
        output_ref,
      })),
  ).toEqual(
    [
      { id: 'alpha', value: 11 },
      { id: 'beta', value: 22 },
      { id: 'gamma', value: 33 },
    ].map((item, ordinal) => ({
      branch_context: {
        branchPath: [],
        iterationPath: [{ loopNodeId: 'for-each', ordinal }],
      },
      output_ref: {
        kind: 'inline',
        value: { item, ordinal },
      },
    })),
  );
  expect(
    facts
      .filter(({ node_id }) => node_id === 'body-sink')
      .map(({ output_ref }) => output_ref),
  ).toEqual(
    [
      { id: 'alpha', value: 11 },
      { id: 'beta', value: 22 },
      { id: 'gamma', value: 33 },
    ].map((item, ordinal) => ({
      kind: 'inline',
      value: { result: { item, ordinal } },
    })),
  );
  // The step after the loop also gets each pass's result, in order.
  const items = [
    { id: 'alpha', value: 11 },
    { id: 'beta', value: 22 },
    { id: 'gamma', value: 33 },
  ];
  expect(
    facts.find(({ node_id }) => node_id === 'outer-successor')?.output_ref,
  ).toEqual({
    kind: 'inline',
    value: {
      result: {
        items,
        iterationCount: 3,
        results: items.map((item, ordinal) => ({
          result: { item, ordinal },
        })),
      },
    },
  });
  expect(facts.filter(({ node_id }) => node_id === 'for-each')).toHaveLength(1);
  await expect(
    workerQuery<{ attempts: string; controls: string }>(
      `select
               count(*)::text attempts,
               count(*) filter (where node.node_id='for-each')::text controls
               from app.node_attempts attempt
               join app.node_runs node on node.id=attempt.node_run_id
              where node.workspace_id=$1 and node.workflow_run_id=$2`,
      [workspaceId, accepted.runId],
    ),
  ).resolves.toEqual([{ attempts: '9', controls: '1' }]);
}
