import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { workspaceA } from '../fixtures.js';
import { emergencyRun, query } from './emergency.fixture.js';

it.each([
  'pending_unknown',
  'terminal_unknown',
  'known_success',
  'definite_failure',
  'historical_unknown',
] as const)(
  'preserves the current persisted %s outcome during emergency settlement',
  async (kind) => {
    const f = await emergencyRun();
    const nodeId = randomUUID(),
      attemptId = randomUUID();
    const unknown = kind === 'pending_unknown' || kind === 'terminal_unknown';
    const nodeStatus =
      kind === 'terminal_unknown'
        ? 'outcome_unknown'
        : kind === 'known_success'
          ? 'succeeded'
          : 'running';
    const attemptStatus =
      kind === 'terminal_unknown'
        ? 'outcome_unknown'
        : kind === 'known_success' || kind === 'historical_unknown'
          ? 'succeeded'
          : 'failed';
    await query(
      "insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,status,side_effect_class) values($1,$2,$3,'step','step',$4,'unsafe')",
      [nodeId, workspaceA, f.runId, nodeStatus],
    );
    await query(
      `insert into app.node_attempts(id,workspace_id,node_run_id,attempt_number,status,side_effect_class,dispatch_marked_at,executor_failure_kind,executor_error_kind,executor_possibly_dispatched,retry_decision,safe_error_code,completed_at)
    values($1,$2,$3,1,$4,'unsafe',clock_timestamp(),$5,$6,$7,$8,$9,clock_timestamp())`,
      [
        attemptId,
        workspaceA,
        nodeId,
        attemptStatus,
        kind === 'pending_unknown'
          ? 'outcome_unknown'
          : kind === 'definite_failure'
            ? 'failed'
            : null,
        kind === 'pending_unknown' || kind === 'definite_failure'
          ? 'network'
          : null,
        kind === 'pending_unknown' || kind === 'definite_failure' ? true : null,
        kind === 'pending_unknown' || kind === 'definite_failure'
          ? 'pending'
          : null,
        unknown
          ? 'provider.outcome_unknown'
          : kind === 'definite_failure'
            ? 'provider.failed'
            : null,
      ],
    );
    await query(
      'update app.node_runs set current_attempt_id=$2,current_attempt_number=1 where id=$1',
      [nodeId, attemptId],
    );
    if (kind === 'historical_unknown')
      await query(
        "insert into app.node_attempts(id,workspace_id,node_run_id,attempt_number,status,side_effect_class,dispatch_marked_at,safe_error_code,completed_at) values($1,$2,$3,2,'outcome_unknown','unsafe',clock_timestamp(),'provider.outcome_unknown',clock_timestamp())",
        [randomUUID(), workspaceA, nodeId],
      );
    const expected = unknown ? 'outcome_unknown' : 'failed';
    expect(await f.fail()).toBe(expected);
    expect(
      (await query('select status from app.node_runs where id=$1', [nodeId]))
        .rows,
    ).toEqual([
      {
        status: unknown
          ? 'outcome_unknown'
          : kind === 'known_success'
            ? 'succeeded'
            : kind === 'definite_failure'
              ? 'failed'
              : 'succeeded',
      },
    ]);
    const notices = await query<{ context: unknown }>(
      'select context from app.run_failure_notification_intents where workflow_run_id=$1',
      [f.runId],
    );
    expect(notices.rows[0]?.context).toMatchObject({
      terminalStatus: expected,
      primaryFailure: { runStatus: expected },
    });
  },
);
