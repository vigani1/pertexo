import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { FailureNotificationContextSchema } from '@pertexo/workflow-model';
import { workspaceA } from '../fixtures.js';
import { emergencyRun, query, safeErrorCode } from './emergency.fixture.js';

it.each(['safe', 'unsafe', 'idempotent_with_key'] as const)(
  'settles %s emergency work with a run-level notification, completed receipt and released capacity',
  async (sideEffectClass) => {
    const f = await emergencyRun();
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    await query(
      "insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,status,side_effect_class,provider_idempotency_key) values($1,$2,$3,'step','step','running',$4,$5)",
      [
        nodeRunId,
        workspaceA,
        f.runId,
        sideEffectClass,
        sideEffectClass === 'idempotent_with_key' ? 'provider-key' : null,
      ],
    );
    await query(
      "insert into app.node_attempts(id,workspace_id,node_run_id,attempt_number,status,side_effect_class,dispatch_marked_at,provider_idempotency_key) values($1,$2,$3,1,'running',$4,clock_timestamp(),$5)",
      [
        attemptId,
        workspaceA,
        nodeRunId,
        sideEffectClass,
        sideEffectClass === 'idempotent_with_key' ? 'provider-key' : null,
      ],
    );
    await query(
      'update app.node_runs set current_attempt_id=$2,current_attempt_number=1 where id=$1',
      [nodeRunId, attemptId],
    );
    const before = await query<{ active_runs: number }>(
      'select active_runs from app.workspace_execution_admission_counters where workspace_id=$1',
      [workspaceA],
    );
    const status = sideEffectClass !== 'safe' ? 'outcome_unknown' : 'failed';
    await expect(f.fail()).resolves.toBe(status);
    const run = await query(
      'select status,completed_at,error_summary from app.workflow_runs where id=$1',
      [f.runId],
    );
    expect(run.rows).toEqual([
      {
        status,
        completed_at: expect.any(Date) as unknown,
        error_summary: safeErrorCode,
      },
    ]);
    const after = await query<{ active_runs: number }>(
      'select active_runs from app.workspace_execution_admission_counters where workspace_id=$1',
      [workspaceA],
    );
    expect(after.rows[0]?.active_runs).toBe(
      (before.rows[0]?.active_runs ?? 0) - 1,
    );
    const receipt = await query(
      'select completed_at from app.inbox_receipts where message_id=$1',
      [f.delivery.outboxEventId],
    );
    expect(receipt.rows).toEqual([
      { completed_at: expect.any(Date) as unknown },
    ]);
    const intents = await query<{ context: unknown; outbox_count: number }>(
      "select i.context,(select count(*)::int from app.outbox_events o where o.aggregate_id=i.id and o.job_name='deliver-run-failure-notification') outbox_count from app.run_failure_notification_intents i where workflow_run_id=$1",
      [f.runId],
    );
    expect(intents.rows).toHaveLength(1);
    expect(intents.rows[0]?.outbox_count).toBe(1);
    expect(
      FailureNotificationContextSchema.parse(intents.rows[0]?.context),
    ).toMatchObject({
      terminalStatus: status,
      primaryFailure: { source: 'run', runStatus: status, safeErrorCode },
      totalFailureCount: 1,
    });
    const nodes = await query(
      'select status from app.node_runs where workflow_run_id=$1',
      [f.runId],
    );
    expect(nodes.rows).toEqual([
      { status: sideEffectClass !== 'safe' ? 'outcome_unknown' : 'canceled' },
    ]);
    await expect(f.fail()).resolves.toBe('not_active');
  },
);
