import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createRetentionStore } from '@pertexo/core/lifecycle';

import { parseCheckpoint } from '@pertexo/workflow-engine';

import { expect } from 'vitest';

import {
  databaseUrl,
  dispatcherUrl,
  ownerQuery,
  workerQuery,
  workspaceId,
} from '../fixture.js';
import type { ForEachPhaseContext } from './contract.js';
import { assertStructuredLoopChildren } from './structured.js';

export async function assertSerialLoopRecovery(context: ForEachPhaseContext) {
  const { accepted, mode, structuredKind, eraseRedisAndRestart } = context;
  const {
    coordinatorOutboxes,
    publishCoordinator,
    continueAfter,
    execute,
    executeDuplicateAttempt,
  } = context.delivery;

  let revision = 3;
  let lastFinishedAttempt: Awaited<ReturnType<typeof execute>> | undefined;
  for (const ordinal of [0, 1, 2]) {
    await execute('body-map', ordinal);
    await continueAfter(++revision);
    const finishedAttempt = await execute(
      structuredKind === 'nested' ? 'nested-body' : 'body-sink',
      ordinal,
    );
    lastFinishedAttempt = finishedAttempt;
    await continueAfter(++revision);
    if (structuredKind === 'nested') {
      const pendingContinuations = await workerQuery<{ id: string }>(
        `select id from app.outbox_events
                  where workspace_id=$1 and aggregate_id=$2
                    and job_name='advance-workflow-run'
                    and not (id=any($3::uuid[]))`,
        [workspaceId, accepted.runId, coordinatorOutboxes],
      );
      if (pendingContinuations.length > 0) await continueAfter(++revision);
    }
    const pruned = await workerQuery<{ scheduler_state: unknown }>(
      `select scheduler_state from app.run_checkpoints
                where workspace_id=$1 and workflow_run_id=$2`,
      [workspaceId, accepted.runId],
    );
    const recovered = parseCheckpoint(pruned[0]?.scheduler_state);
    expect(recovered.loops).toHaveLength(1);
    expect(recovered.loops[0]).toMatchObject({
      completedPrefix: ordinal + 1,
      terminalOrdinals: [],
    });
    expect(
      recovered.invocations.every(
        ({ iterationPath }) => iterationPath?.[0]?.ordinal !== ordinal,
      ),
    ).toBe(true);
    if (structuredKind === 'nested')
      expect(recovered.retiredIterationBudget).toBe(ordinal + 1);
    const readHistory = () =>
      workerQuery<{
        attempts: string;
        events: string;
        outputs: string;
      }>(
        `select
                 (select count(*)::text from app.node_attempts attempt
                   join app.node_runs node on node.id=attempt.node_run_id
                   where node.workspace_id=$1 and node.workflow_run_id=$2) attempts,
                 (select count(*)::text from app.run_events
                   where workspace_id=$1 and workflow_run_id=$2) events,
                 (select count(*)::text from app.node_runs
                   where workspace_id=$1 and workflow_run_id=$2
                     and output_ref is not null) outputs`,
        [workspaceId, accepted.runId],
      );
    const history = await readHistory();
    expect(Number(history[0]?.outputs)).toBeGreaterThan(ordinal + 2);
    if (mode === 'serial_complete' && ordinal === 0) {
      const retention = createRetentionStore(
        parseDatabaseConfig({
          connectionString: databaseUrl(dispatcherUrl),
          max: 1,
        }),
      );
      try {
        const pass = await retention.enforce();
        expect(pass.removed.node_runs).toBe(0);
        expect(pass.removed.run_events).toBe(0);
        expect(pass.removed.run_checkpoints).toBe(0);
        await expect(readHistory()).resolves.toEqual(history);
      } finally {
        await retention.close();
      }
    }
    await eraseRedisAndRestart();
    await executeDuplicateAttempt(finishedAttempt);
    await expect(readHistory()).resolves.toEqual(history);
  }
  if (structuredKind !== undefined) {
    await assertStructuredLoopChildren({ accepted, structuredKind });
  }
  const beforeSuccessor = await workerQuery<{
    node_id: string;
    status: string;
  }>(
    `select node_id,status from app.node_runs
              where workspace_id=$1 and workflow_run_id=$2
                and node_id in ('for-each','outer-successor') order by node_id`,
    [workspaceId, accepted.runId],
  );
  expect(beforeSuccessor).toEqual([
    { node_id: 'for-each', status: 'succeeded' },
  ]);
  // Serial outcomes leave no spare completion wakeup. The coordinator
  // must persist its own continuation when it completes the loop.
  const readContinuations = () =>
    workerQuery<{ id: string }>(
      `select id from app.outbox_events
              where workspace_id=$1 and aggregate_id=$2
                and job_name='advance-workflow-run'
                and not (id=any($3::uuid[]))`,
      [workspaceId, accepted.runId, coordinatorOutboxes],
    );
  const continuations = await readContinuations();
  expect(continuations).toHaveLength(1);
  const loopCompletion = coordinatorOutboxes.at(-1);
  if (loopCompletion === undefined)
    throw new Error('Serial loop completion delivery missing');
  await eraseRedisAndRestart();
  // Redelivery after Redis loss must replay the receipt, not enqueue
  // another continuation or move the checkpoint a second time.
  await publishCoordinator(loopCompletion, revision);
  await expect(readContinuations()).resolves.toEqual(continuations);
  await expect(
    workerQuery<{ completed: boolean; receipts: string }>(
      `select count(*)::text receipts,
                      bool_and(completed_at is not null) completed
                 from app.inbox_receipts
                where workspace_id=$1 and message_id=$2`,
      [workspaceId, loopCompletion],
    ),
  ).resolves.toEqual([{ completed: true, receipts: '1' }]);
  await continueAfter(++revision);
  await execute('outer-successor');
  await continueAfter(++revision);
  await expect(
    workerQuery<{ status: string }>(
      `select status from app.workflow_runs where workspace_id=$1 and id=$2`,
      [workspaceId, accepted.runId],
    ),
  ).resolves.toEqual([{ status: 'succeeded' }]);
  await expect(readContinuations()).resolves.toEqual([]);
  if (mode === 'serial_complete') {
    await ownerQuery(
      `update app.workflow_runs set completed_at=clock_timestamp()-interval '31 days'
                where workspace_id=$1 and id=$2`,
      [workspaceId, accepted.runId],
    );
    const retention = createRetentionStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(dispatcherUrl),
        max: 1,
      }),
    );
    try {
      await retention.enforce();
    } finally {
      await retention.close();
    }
    await expect(
      workerQuery<{
        nodes: string;
        checkpoints: string;
        events: string;
        status: string;
      }>(
        `select run.status,
                 (select count(*)::text from app.node_runs where workflow_run_id=run.id) nodes,
                 (select count(*)::text from app.run_events where workflow_run_id=run.id) events,
                 (select count(*)::text from app.run_checkpoints where workflow_run_id=run.id) checkpoints
                 from app.workflow_runs run where workspace_id=$1 and id=$2`,
        [workspaceId, accepted.runId],
      ),
    ).resolves.toEqual([
      {
        status: 'succeeded',
        nodes: '0',
        events: '0',
        checkpoints: '0',
      },
    ]);
    if (lastFinishedAttempt === undefined)
      throw new Error('finished iteration attempt missing');
    await eraseRedisAndRestart();
    await executeDuplicateAttempt(lastFinishedAttempt);
    await expect(
      workerQuery<{
        nodes: string;
        checkpoints: string;
        events: string;
      }>(
        `select
                 (select count(*)::text from app.node_runs where workspace_id=$1 and workflow_run_id=$2) nodes,
                 (select count(*)::text from app.run_checkpoints where workspace_id=$1 and workflow_run_id=$2) checkpoints,
                 (select count(*)::text from app.run_events where workspace_id=$1 and workflow_run_id=$2) events`,
        [workspaceId, accepted.runId],
      ),
    ).resolves.toEqual([{ nodes: '0', checkpoints: '0', events: '0' }]);
  }
  return;
}
