import {
  createDeadlineWakeupScanner,
  createNodeAttemptRunStore,
} from '@pertexo/core/testing';
import { parseDatabaseConfig } from '@pertexo/database/testing';

import { parseCheckpoint } from '@pertexo/workflow-engine';

import { expect } from 'vitest';
import { cancelFixtureRun } from '../../../../support/coordinator/runs.js';
import {
  databaseUrl,
  ownerQuery,
  workerQuery,
  workerUrl,
  workspaceId,
} from '../fixture.js';
import type { ForEachPhaseContext } from './contract.js';

export async function assertRunningLoopControl(context: ForEachPhaseContext) {
  const { accepted, mode, stopWorkers, eraseRedisAndRestart } = context;
  const { continueAfter, findAttempt } = context.delivery;

  const attempts = await Promise.all(
    [0, 1].map((ordinal) => findAttempt('body-map', ordinal)),
  );
  const store = createNodeAttemptRunStore(
    parseDatabaseConfig({
      connectionString: databaseUrl(workerUrl),
      max: 2,
    }),
  );
  try {
    const claimed = await Promise.all(
      attempts.map(async (attempt, ordinal) => {
        const result = await store.claimDelivery({
          workspaceId,
          runId: accepted.runId,
          nodeRunId: attempt.node_run_id,
          attemptId: attempt.attempt_id,
          delivery: {
            outboxEventId: attempt.outbox_id,
            payloadChecksum: attempt.payload_checksum,
          },
          leaseDurationSeconds: 30,
          workerId: `for-each-${mode}-${String(ordinal)}`,
          signal: new AbortController().signal,
        });
        if (result.kind !== 'claimed')
          throw new Error(`For Each attempt was not claimed: ${result.kind}`);
        return result;
      }),
    );
    const firstClaim = claimed[0];
    const secondClaim = claimed[1];
    if (firstClaim === undefined || secondClaim === undefined)
      throw new Error('For Each running claims are incomplete');

    if (mode === 'cancel_running') {
      await cancelFixtureRun(
        accepted.runId,
        'cancel while canonical body attempt is running',
      );
    } else {
      // The child also scans deadlines; stop it before asserting this scanner owns the wakeup.
      await stopWorkers();
      // Already passed, yet after creation: the run may be under a second old.
      await ownerQuery(
        `update app.workflow_runs
                    set deadline_at=created_at+interval '1 millisecond',
                        deadline_wakeup_at=null,
                        updated_at=clock_timestamp()
                  where workspace_id=$1 and id=$2`,
        [workspaceId, accepted.runId],
      );
      const scanner = createDeadlineWakeupScanner(
        parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
          max: 1,
        }),
      );
      try {
        await expect(scanner.claimDueWakeups(10)).resolves.toBe(1);
      } finally {
        await scanner.close();
      }
    }

    await eraseRedisAndRestart();
    await continueAfter(4);
    const stopped = await workerQuery<{
      scheduler_state: unknown;
      node_id: string;
      status: string;
    }>(
      `select node.node_id,node.status,checkpoint.scheduler_state
                 from app.node_runs node
                 join app.run_checkpoints checkpoint
                   on checkpoint.workflow_run_id=node.workflow_run_id
                where node.workspace_id=$1 and node.workflow_run_id=$2
                  and node.node_id='body-map'
                order by (node.branch_context->'iterationPath'->0->>'ordinal')::int`,
      [workspaceId, accepted.runId],
    );
    expect(stopped.map(({ status }) => status)).toEqual(['running', 'running']);
    expect(parseCheckpoint(stopped[0]?.scheduler_state)).toMatchObject({
      cancelRequested: mode === 'cancel_running',
      deadlineExpired: mode === 'deadline_running',
      remainingIterationBudget: 997,
      runStatus: 'running',
      loops: [
        {
          activeOrdinals: [0, 1],
          nextOrdinal: 2,
          terminalOrdinals: [],
        },
      ],
    });
    await expect(
      workerQuery<{ attempts: string; new_work: string }>(
        `select
                   count(*)::text attempts,
                   count(*) filter (
                     where node.node_id='body-sink'
                        or node.branch_context->'iterationPath'
                           @> '[{"loopNodeId":"for-each","ordinal":2}]'::jsonb
                   )::text new_work
                   from app.node_attempts attempt
                   join app.node_runs node on node.id=attempt.node_run_id
                  where node.workspace_id=$1 and node.workflow_run_id=$2`,
        [workspaceId, accepted.runId],
      ),
    ).resolves.toEqual([{ attempts: '4', new_work: '0' }]);

    const firstCompletion = await store.complete({
      lease: firstClaim.lease,
      outcome: {
        status: 'succeeded',
        output: {
          item: { id: 'alpha', value: 11 },
          ordinal: 0,
        },
      },
      signal: new AbortController().signal,
    });
    expect(firstCompletion.kind).toBe('committed');
    await continueAfter(5);
    const secondCompletion = await store.complete({
      lease: secondClaim.lease,
      outcome:
        mode === 'cancel_running'
          ? {
              status: 'canceled',
              safeErrorCode: 'execution.canceled',
            }
          : {
              status: 'outcome_unknown',
              safeErrorCode: 'execution.outcome_unknown',
            },
      signal: new AbortController().signal,
    });
    expect(secondCompletion.kind).toBe('committed');
    await continueAfter(6);
    const terminal = await workerQuery<{
      scheduler_state: unknown;
      status: string;
    }>(
      `select run.status,checkpoint.scheduler_state
                 from app.workflow_runs run
                 join app.run_checkpoints checkpoint
                   on checkpoint.workflow_run_id=run.id
                where run.workspace_id=$1 and run.id=$2`,
      [workspaceId, accepted.runId],
    );
    expect(terminal[0]?.status).toBe(
      mode === 'cancel_running' ? 'canceled' : 'outcome_unknown',
    );
    expect(parseCheckpoint(terminal[0]?.scheduler_state)).toMatchObject({
      remainingIterationBudget: 997,
      runStatus: mode === 'cancel_running' ? 'canceled' : 'outcome_unknown',
      loops: [
        {
          activeOrdinals: [],
          nextOrdinal: 2,
          completedPrefix: 2,
          terminalOrdinals: [],
        },
      ],
    });
    await expect(
      workerQuery<{ attempts: string; new_work: string }>(
        `select
                   count(*)::text attempts,
                   count(*) filter (
                     where node.node_id='body-sink'
                        or node.branch_context->'iterationPath'
                           @> '[{"loopNodeId":"for-each","ordinal":2}]'::jsonb
                   )::text new_work
                   from app.node_attempts attempt
                   join app.node_runs node on node.id=attempt.node_run_id
                  where node.workspace_id=$1 and node.workflow_run_id=$2`,
        [workspaceId, accepted.runId],
      ),
    ).resolves.toEqual([{ attempts: '4', new_work: '0' }]);
  } finally {
    await store.close();
  }
  return;
}
