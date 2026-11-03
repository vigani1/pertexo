import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { claimDispatchAttempt } from '../runs/run-store/node-attempts/fixture.js';
import { adminBaseUrl, databaseUrl } from '../runs/run-store/fixtures.js';

/** Enough that the planner sees a scan of a workspace's steps as a real cost. */
const STEPS = 5_000;

/**
 * Runs a statement with `auto_explain` reporting the plans of nested statements, so
 * what's read is the check PostgreSQL itself runs for the foreign key, at commit,
 * and not a hand-written copy of it.
 */
async function plansOf(
  statement: string,
  values: readonly unknown[],
  settings: readonly string[] = [],
): Promise<readonly string[]> {
  const client = new Client({ connectionString: databaseUrl(adminBaseUrl) });
  const plans: string[] = [];
  client.on('notice', ({ message }) => {
    if (message !== undefined) plans.push(message);
  });
  await client.connect();
  try {
    await client.query(`load 'auto_explain'`);
    await client.query(`set auto_explain.log_min_duration = 0`);
    await client.query(`set auto_explain.log_nested_statements = on`);
    await client.query(`set auto_explain.log_level = notice`);
    for (const setting of settings) await client.query(setting);
    await client.query('begin');
    await client.query(statement, [...values]);
    await client.query('commit');
  } finally {
    await client.end();
  }
  return plans;
}

const planNaming = (plans: readonly string[], pattern: RegExp): string => {
  const found = plans.filter((plan) => pattern.test(plan));
  expect(found).toHaveLength(1);
  return found[0] ?? '';
};

describe('the foreign keys retention deletes through', () => {
  let attemptId: string;
  let nodeRunId: string;

  beforeAll(async () => {
    const lease = await claimDispatchAttempt(`plan-${randomUUID()}`, {
      sideEffectClass: 'safe',
    });
    nodeRunId = lease.nodeRunId;
    attemptId = randomUUID();
    const admin = new Client({ connectionString: databaseUrl(adminBaseUrl) });
    await admin.connect();
    try {
      // Steps of one workspace, none on an attempt, as finished runs' are not: the
      // partial index stays small and the rest of the table is what a scan would read.
      await admin.query(
        `insert into app.node_runs
         select (jsonb_populate_record(step, jsonb_build_object(
           'id', gen_random_uuid(),
           'invocation_key', replace(step.invocation_key, '|plan-', '|plan-' || n || '-'),
           'current_attempt_id', null,
           'current_attempt_number', null,
           'status', 'ready',
           'started_at', null,
           'completed_at', null
         ))).*
           from app.node_runs step, generate_series(1, $2::int) n
          where step.id = $1`,
        [nodeRunId, STEPS],
      );
      await admin.query(
        `insert into app.node_attempts
         select (jsonb_populate_record(attempt, jsonb_build_object(
           'id', $2::uuid,
           'attempt_number', attempt.attempt_number + 1,
           'status', 'succeeded',
           'lease_owner', null,
           'lease_expires_at', null
         ))).*
           from app.node_attempts attempt where attempt.id = $1`,
        [lease.attemptId, attemptId],
      );
      await admin.query('analyze app.node_runs');
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('checks a deleted attempt against its index, not by reading the steps', async () => {
    const plans = await plansOf('delete from app.node_attempts where id = $1', [
      attemptId,
    ]);

    const check = planNaming(plans, /FROM ONLY "app"\."node_runs"/u);
    expect(check).toContain('current_attempt_id');
    expect(check).toContain('node_runs_current_attempt_idx');
    expect(check).not.toContain('Seq Scan');
  });

  // An empty table is cheapest to scan, so the plan only shows the index once the
  // planner is told a scan isn't an option. The name is what matters: another index
  // starting at the workspace would read every task it has.
  it('cascades a deleted step to its tasks through their index', async () => {
    const plans = await plansOf(
      `delete from app.node_runs where id = (
         select id from app.node_runs
          where current_attempt_id is null and id <> $1 limit 1
       )`,
      [nodeRunId],
      ['set enable_seqscan = off'],
    );

    const cascade = planNaming(plans, /FROM ONLY "app"\."pending_run_tasks"/u);
    expect(cascade).toContain('pending_run_tasks_node_idx');
  });
});
