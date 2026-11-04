import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import {
  asAdmin,
  databaseUrl,
  workerBaseUrl,
  workspaceA,
} from '../fixtures.js';
import { claimDispatchAttempt } from '../node-attempts/fixture.js';
import { nodeAttemptStore } from '../fixtures.js';
import { NodeAttemptStateCorruptError } from '../../../../src/attempts/node-attempt.errors.js';
import { query } from './emergency.fixture.js';
import { failUnadvanceableRun } from '../../../../src/runs/advance/fail-unadvanceable.repository.js';

const pool = new Pool({ connectionString: databaseUrl(workerBaseUrl), max: 1 });
afterAll(() => pool.end());
it.each(['expired', 'replaced'] as const)(
  'rejects an emergency report from the %s attempt owner even at the same checkpoint revision',
  async (ownership) => {
    const lease = await claimDispatchAttempt(`emergency-${ownership}`);
    await asAdmin((client) =>
      ownership === 'expired'
        ? client.query(
            "update app.node_attempts set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
            [lease.attemptId],
          )
        : client.query(
            "update app.node_attempts set lease_owner='replacement-worker',fence_token=fence_token+1,lease_expires_at=clock_timestamp()+interval '1 minute' where id=$1",
            [lease.attemptId],
          ),
    );
    const before = await ownershipSnapshot(lease.runId);
    expect(
      await failUnadvanceableRun(pool, {
        workspaceId: workspaceA,
        runId: lease.runId,
        expectedRevision: lease.checkpointRevision,
        attemptLease: lease,
        safeErrorCode: 'execution.run_state_invalid',
        signal: new AbortController().signal,
      }),
    ).toBe('stale');
    expect(await ownershipSnapshot(lease.runId)).toEqual(before);
  },
);

async function ownershipSnapshot(runId: string) {
  return (
    await query(
      `select r.status,r.error_summary,c.revision,a.status attempt_status,a.lease_owner,a.fence_token,
    (select count(*)::int from app.run_events e where e.workflow_run_id=r.id) events,
    (select active_runs from app.workspace_execution_admission_counters where workspace_id=r.workspace_id) active
    from app.workflow_runs r join app.run_checkpoints c on c.workflow_run_id=r.id
    join app.node_runs n on n.workflow_run_id=r.id join app.node_attempts a on a.id=n.current_attempt_id where r.id=$1`,
      [runId],
    )
  ).rows;
}

it.each(['repaired', 'replaced', 'advanced'] as const)(
  'refuses a claim-time corruption report after its state was %s',
  async (change) => {
    const lease = await claimDispatchAttempt(`claim-refusal-${change}`);
    await asAdmin(async (client) => {
      await client.query(
        "update app.node_attempts set status='ready',lease_owner=null,lease_expires_at=null where id=$1",
        [lease.attemptId],
      );
      await client.query(
        `update app.node_runs set status='ready',branch_context='{"bad":"stored"}'::jsonb where id=$1`,
        [lease.nodeRunId],
      );
    });
    const refused: unknown = await nodeAttemptStore
      .claimDelivery({
        ...lease,
        leaseDurationSeconds: 30,
        signal: AbortSignal.timeout(10000),
      })
      .catch((error: unknown) => error);
    if (
      !(refused instanceof NodeAttemptStateCorruptError) ||
      refused.claimRefusal === undefined
    )
      throw new Error('Expected a bound claim refusal');
    await asAdmin(async (client) => {
      if (change === 'repaired')
        await client.query(
          "update app.node_runs set branch_context='{}'::jsonb where id=$1",
          [lease.nodeRunId],
        );
      else if (change === 'replaced')
        await client.query(
          'update app.node_attempts set fence_token=fence_token+1 where id=$1',
          [lease.attemptId],
        );
      else
        await client.query(
          'update app.run_checkpoints set revision=revision+1 where workflow_run_id=$1',
          [lease.runId],
        );
    });
    const before = await ownershipSnapshot(lease.runId);
    expect(
      await failUnadvanceableRun(pool, {
        workspaceId: workspaceA,
        runId: lease.runId,
        expectedRevision: refused.claimRefusal.checkpointRevision,
        claimRefusal: refused.claimRefusal,
        safeErrorCode: 'execution.run_state_invalid',
        signal: AbortSignal.timeout(10000),
      }),
    ).toBe('stale');
    expect(await ownershipSnapshot(lease.runId)).toEqual(before);
  },
);
