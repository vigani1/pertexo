import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { workspaceA } from '../run-store.fixture.js';
import { emergencyRun, query } from './emergency.fixture.js';

const cases = [
  {
    name: 'pending unknown',
    node: 'running',
    attempt: 'failed',
    failure: 'outcome_unknown',
    safeCode: 'provider.outcome_unknown',
    run: 'outcome_unknown',
    settledNode: 'outcome_unknown',
    historical: false,
  },
  {
    name: 'terminal unknown',
    node: 'outcome_unknown',
    attempt: 'outcome_unknown',
    failure: null,
    safeCode: 'provider.outcome_unknown',
    run: 'outcome_unknown',
    settledNode: 'outcome_unknown',
    historical: false,
  },
  {
    name: 'known success',
    node: 'succeeded',
    attempt: 'succeeded',
    failure: null,
    safeCode: null,
    run: 'failed',
    settledNode: 'succeeded',
    historical: false,
  },
  {
    name: 'definite failure',
    node: 'running',
    attempt: 'failed',
    failure: 'failed',
    safeCode: 'provider.failed',
    run: 'failed',
    settledNode: 'failed',
    historical: false,
  },
  {
    name: 'known current success after historical unknown',
    node: 'running',
    attempt: 'succeeded',
    failure: null,
    safeCode: null,
    run: 'failed',
    settledNode: 'succeeded',
    historical: true,
  },
] as const;
it.each(cases)(
  'preserves $name during emergency settlement',
  async (testCase) => {
    const f = await emergencyRun();
    const nodeId = randomUUID(),
      attemptId = randomUUID();
    const attemptNumber = testCase.historical ? 2 : 1;
    await query(
      "insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,status,side_effect_class) values($1,$2,$3,'step','step',$4,'unsafe')",
      [nodeId, workspaceA, f.runId, testCase.node],
    );
    await query(
      `insert into app.node_attempts(id,workspace_id,node_run_id,attempt_number,status,side_effect_class,dispatch_marked_at,executor_failure_kind,executor_error_kind,executor_possibly_dispatched,retry_decision,safe_error_code,completed_at)
    values($1,$2,$3,$4,$5,'unsafe',clock_timestamp(),$6,$7,$8,$9,$10,clock_timestamp())`,
      [
        attemptId,
        workspaceA,
        nodeId,
        attemptNumber,
        testCase.attempt,
        testCase.failure,
        testCase.failure === null ? null : 'network',
        testCase.failure === null ? null : true,
        testCase.failure === null ? null : 'pending',
        testCase.safeCode,
      ],
    );
    await query(
      'update app.node_runs set current_attempt_id=$2,current_attempt_number=$3 where id=$1',
      [nodeId, attemptId, attemptNumber],
    );
    if (testCase.historical)
      await query(
        "insert into app.node_attempts(id,workspace_id,node_run_id,attempt_number,status,side_effect_class,dispatch_marked_at,safe_error_code,completed_at) values($1,$2,$3,1,'outcome_unknown','unsafe',clock_timestamp(),'provider.outcome_unknown',clock_timestamp())",
        [randomUUID(), workspaceA, nodeId],
      );
    expect(await f.fail()).toBe(testCase.run);
    expect(
      (await query('select status from app.node_runs where id=$1', [nodeId]))
        .rows,
    ).toEqual([{ status: testCase.settledNode }]);
    const notices = await query<{ context: unknown }>(
      'select context from app.run_failure_notification_intents where workflow_run_id=$1',
      [f.runId],
    );
    expect(notices.rows[0]?.context).toMatchObject({
      terminalStatus: testCase.run,
      primaryFailure: { runStatus: testCase.run },
    });
  },
);
