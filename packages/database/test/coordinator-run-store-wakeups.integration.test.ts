import { describe, it, expect } from 'vitest';

import {
  Pool,
  asRuntime,
  canonicalOutboxPayloadChecksum,
  createDeadlineWakeupScanner,
  databaseUrl,
  insertRun,
  parseDatabaseConfig,
  randomUUID,
  versionA,
  workerBaseUrl,
  workspaceA,
} from './coordinator-run-store.fixtures.js';

describe('Coordinator durable wakeup invariants', () => {
  it('wakes each due workflow deadline exactly once independently of node timing', async () => {
    const deadlineAt = new Date(Date.now() + 100).toISOString();
    const runId = await insertRun({ deadlineAt, status: 'waiting' });
    const config = parseDatabaseConfig({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });
    const scannerA = createDeadlineWakeupScanner(config);
    const scannerB = createDeadlineWakeupScanner(config);
    try {
      await scannerA.claimDueWakeups(100);
      const beforeDue = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ deadline_wakeup_at: Date | null; outboxes: number }>(
          `select run.deadline_wakeup_at,
                    (select count(*)::int from app.outbox_events
                      where aggregate_id=run.id and job_name='advance-workflow-run') outboxes
             from app.workflow_runs run where run.id=$1`,
          [runId],
        ),
      );
      expect(beforeDue.rows[0]).toEqual({
        deadline_wakeup_at: null,
        outboxes: 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const claims = await Promise.all([
        scannerA.claimDueWakeups(10),
        scannerB.claimDueWakeups(10),
      ]);
      expect(claims.reduce((sum, claimed) => sum + claimed, 0)).toBe(1);
      await expect(scannerA.claimDueWakeups(10)).resolves.toBe(0);
      const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          deadline_marked: boolean;
          id: string;
          payload: Record<string, unknown>;
          payload_checksum: string;
        }>(
          `select run.deadline_wakeup_at=run.deadline_at deadline_marked,
                    event.id,event.payload,event.payload_checksum
             from app.workflow_runs run
             join app.outbox_events event on event.aggregate_id=run.id
               and event.job_name='advance-workflow-run'
             where run.id=$1`,
          [runId],
        ),
      );
      expect(proof.rows).toHaveLength(1);
      expect(proof.rows[0]).toMatchObject({ deadline_marked: true });
      expect(proof.rows[0]?.payload).toEqual({
        outboxEventId: proof.rows[0]?.id,
        runId,
        schemaVersion: 1,
        workspaceId: workspaceA,
      });
      expect(proof.rows[0]?.payload_checksum).toBe(
        canonicalOutboxPayloadChecksum(proof.rows[0]?.payload),
      );
    } finally {
      await Promise.all([scannerA.close(), scannerB.close()]);
    }
  });

  it('wakes each due node fact exactly once across concurrent global scans', async () => {
    const runId = await insertRun({ status: 'running' });
    const nodeRunId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,retry_due_at
           ) values ($1,$2,$3,'retry-node',$4,'{}','waiting','safe',
                     clock_timestamp() + interval '1 hour')`,
        [nodeRunId, workspaceA, runId, `${versionA}|retry-node|b:|i:`],
      ),
    );
    const scannerA = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    const scannerB = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    try {
      await expect(
        scannerA.query('select app.claim_due_node_run_wakeups(null)'),
      ).rejects.toMatchObject({ code: '22023' });
      await scannerA.query(
        'select app.claim_due_node_run_wakeups(100) claimed',
      );
      const beforeDue = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ count: number }>(
          `select count(*)::int count from app.outbox_events
             where aggregate_id=$1 and job_name='advance-workflow-run'`,
          [runId],
        ),
      );
      expect(beforeDue.rows[0]?.count).toBe(0);
      await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.node_runs set retry_due_at=clock_timestamp()-interval '1 second',
               due_wakeup_at=null where id=$1`,
          [nodeRunId],
        ),
      );

      const scans = await Promise.all([
        scannerA.query<{ claimed: number }>(
          'select app.claim_due_node_run_wakeups(10) claimed',
        ),
        scannerB.query<{ claimed: number }>(
          'select app.claim_due_node_run_wakeups(10) claimed',
        ),
      ]);
      expect(
        scans.reduce((sum, result) => sum + (result.rows[0]?.claimed ?? 0), 0),
      ).toBe(1);
      await expect(
        scannerA.query('select app.claim_due_node_run_wakeups(10) claimed'),
      ).resolves.toMatchObject({ rows: [{ claimed: 0 }] });

      const first = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          id: string;
          payload: Record<string, unknown>;
          payload_checksum: string;
        }>(
          `select id,payload,payload_checksum from app.outbox_events
             where aggregate_id=$1 and job_name='advance-workflow-run'`,
          [runId],
        ),
      );
      expect(first.rows).toHaveLength(1);
      expect(first.rows[0]?.payload).toEqual({
        outboxEventId: first.rows[0]?.id,
        runId,
        schemaVersion: 1,
        workspaceId: workspaceA,
      });
      expect(first.rows[0]?.payload_checksum).toBe(
        canonicalOutboxPayloadChecksum(first.rows[0]?.payload),
      );
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `update app.node_runs
                  set due_wakeup_at=retry_due_at + interval '1 second'
                where id=$1`,
            [nodeRunId],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });

      await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.node_runs
                set retry_due_at=clock_timestamp()-interval '2 seconds',
                    due_wakeup_at=null
              where id=$1`,
          [nodeRunId],
        ),
      );
      await expect(
        scannerB.query('select app.claim_due_node_run_wakeups(10) claimed'),
      ).resolves.toMatchObject({ rows: [{ claimed: 1 }] });
      const count = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ count: number }>(
          `select count(*)::int count from app.outbox_events
             where aggregate_id=$1 and job_name='advance-workflow-run'`,
          [runId],
        ),
      );
      expect(count.rows[0]?.count).toBe(2);
    } finally {
      await Promise.all([scannerA.end(), scannerB.end()]);
    }
  });
});
