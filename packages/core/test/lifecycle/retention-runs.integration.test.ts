import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  checkpoints,
  events,
  nodeDetails,
} from '../../src/lifecycle/retention/rules/run-records.repository.js';
import {
  adminUrl,
  retention,
  withDatabase,
  workspaceId,
} from './retention.support.js';

const DAY = 86_400_000;
const MINUTE = 60_000;
const ago = (millis: number) => new Date(Date.now() - millis);

let admin!: Client;

beforeAll(async () => {
  admin = new Client({ connectionString: withDatabase(adminUrl) });
  await admin.connect();
  await admin.query("select set_config('app.workspace_id', $1, false)", [
    workspaceId,
  ]);
});

afterAll(async () => {
  await admin.end();
});

type RunShape = Readonly<{
  completedAt?: Date;
  createdAt?: Date;
  purged?: boolean;
  status?: string;
  triggerType?: string;
}>;

async function insertRun({
  completedAt,
  createdAt,
  purged = false,
  status = completedAt === undefined ? 'running' : 'succeeded',
  triggerType = 'manual',
}: RunShape): Promise<string> {
  const id = randomUUID();
  const created = createdAt ?? completedAt ?? new Date();
  await admin.query(
    `insert into app.workflow_runs
      (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
       output_ref,error_summary,started_at,completed_at,details_purged_at,
       created_at,updated_at)
     values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$9,$9)`,
    [
      id,
      workspaceId,
      randomUUID(),
      randomUUID(),
      triggerType,
      status,
      purged ? null : JSON.stringify({ kind: 'inline', value: 'output' }),
      purged ? null : 'failure detail',
      created,
      completedAt ?? null,
      purged ? (completedAt ?? new Date()) : null,
    ],
  );
  return id;
}

async function insertNodeRun(runId: string): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into app.node_runs
      (id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
       status,side_effect_class)
     values($1,$2,$3,'node',$4,'{}','succeeded','safe')`,
    [id, workspaceId, runId, `node-${id}`],
  );
  await admin.query(
    `insert into app.node_attempts
      (id,workspace_id,node_run_id,attempt_number,status,side_effect_class)
     values($1,$2,$3,1,'succeeded','safe')`,
    [randomUUID(), workspaceId, id],
  );
  return id;
}

async function insertEvent(runId: string, sequence = 1): Promise<void> {
  await admin.query(
    `insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload)
     values($1,$2,$3,'run.succeeded','{}')`,
    [workspaceId, runId, sequence],
  );
}

async function insertCheckpoint(runId: string): Promise<void> {
  await admin.query(
    `insert into app.run_checkpoints
      (workflow_run_id,workspace_id,workflow_version_id,revision,scheduler_state)
     select id,workspace_id,workflow_version_id,1,'{}'
       from app.workflow_runs where id=$1`,
    [runId],
  );
}

async function insertDetails(runId: string): Promise<void> {
  await insertNodeRun(runId);
  await insertEvent(runId);
  await insertCheckpoint(runId);
}

async function countOf(table: string, runId: string): Promise<number> {
  const result = await admin.query<{ count: number }>(
    `select count(*)::int "count" from app.${table} where workflow_run_id=$1`,
    [runId],
  );
  return result.rows[0]?.count ?? -1;
}

async function detailCounts(runId: string) {
  return {
    node_runs: await countOf('node_runs', runId),
    run_events: await countOf('run_events', runId),
    run_checkpoints: await countOf('run_checkpoints', runId),
  };
}

const allDetails = { node_runs: 1, run_events: 1, run_checkpoints: 1 };
const noDetails = { node_runs: 0, run_events: 0, run_checkpoints: 0 };

async function summary(runId: string) {
  const result = await admin.query<{
    details_purged_at: Date | null;
    error_summary: string | null;
    output_ref: unknown;
  }>(
    'select details_purged_at,error_summary,output_ref from app.workflow_runs where id=$1',
    [runId],
  );
  return result.rows[0];
}

async function untilIdle(): Promise<void> {
  for (let pass = 0; pass < 200; pass += 1)
    if (!(await retention.enforce()).more) return;
  throw new Error('Retention did not become idle');
}

describe('run retention windows', () => {
  it('removes every detail of a run a minute past 30 days and then marks it purged, keeping the summary', async () => {
    const runId = await insertRun({ completedAt: ago(30 * DAY + MINUTE) });
    await insertDetails(runId);

    await untilIdle();

    expect(await detailCounts(runId)).toEqual(noDetails);
    expect(await summary(runId)).toMatchObject({
      output_ref: null,
      error_summary: null,
      details_purged_at: expect.any(Date),
    });
  });

  it('keeps every detail of a run a minute inside 30 days', async () => {
    const runId = await insertRun({ completedAt: ago(30 * DAY - MINUTE) });
    await insertDetails(runId);

    await untilIdle();

    expect(await detailCounts(runId)).toEqual(allDetails);
    expect(await summary(runId)).toMatchObject({
      details_purged_at: null,
      error_summary: 'failure detail',
    });
  });

  it('counts a test run from its creation, seven days out', async () => {
    const expired = await insertRun({
      triggerType: 'test',
      createdAt: ago(7 * DAY + MINUTE),
      completedAt: ago(MINUTE),
    });
    const kept = await insertRun({
      triggerType: 'test',
      createdAt: ago(7 * DAY - MINUTE),
      completedAt: ago(MINUTE),
    });
    await insertDetails(expired);
    await insertDetails(kept);

    await untilIdle();

    expect(await detailCounts(expired)).toEqual(noDetails);
    expect(await detailCounts(kept)).toEqual(allDetails);
  });

  it('counts an ordinary run from its completion, however old it is', async () => {
    const runId = await insertRun({
      createdAt: ago(60 * DAY),
      completedAt: ago(DAY),
    });
    await insertDetails(runId);

    await untilIdle();

    expect(await detailCounts(runId)).toEqual(allDetails);
  });

  it('deletes a summary a minute past 90 days and keeps one a minute inside', async () => {
    const expired = await insertRun({
      completedAt: ago(90 * DAY + MINUTE),
      purged: true,
    });
    const kept = await insertRun({
      completedAt: ago(90 * DAY - MINUTE),
      purged: true,
    });

    await untilIdle();

    expect(await summary(expired)).toBeUndefined();
    expect(await summary(kept)).toBeDefined();
  });
});

describe('rows that follow a run past its 30 days', () => {
  async function insertFollowers(runId: string): Promise<void> {
    await admin.query(
      `insert into app.data_table_write_receipts
        (workspace_id,execution_id,invocation_id,run_id,request_hash,result_json)
       values($1,$2,$3,$2,$4,'{}')`,
      [workspaceId, runId, randomUUID(), 'a'.repeat(64)],
    );
    await admin.query(
      `insert into app.webhook_run_responses(run_id,workspace_id,wait_seconds)
       values($1,$2,30)`,
      [runId, workspaceId],
    );
    await admin.query(
      `insert into app.pending_run_tasks
        (id,workspace_id,run_id,workflow_version_id,invocation_key,kind,config,status,
         callback_node_id,callback_scope,callback_scope_hash,callback_token_hash,
         callback_key_version,completed_at,consumed_at)
       select uuidv7(),workspace_id,id,workflow_version_id,'prepared','callback','{}',
         'canceled','callback','[]',$2,$2,'retired',clock_timestamp(),clock_timestamp()
       from app.workflow_runs where id=$1`,
      [runId, randomUUID().replaceAll('-', '').padEnd(64, '0')],
    );
  }
  async function followers(runId: string) {
    const count = async (table: string, column: string) =>
      (
        await admin.query(`select 1 from app.${table} where ${column}=$1`, [
          runId,
        ])
      ).rowCount;
    return {
      receipts: await count('data_table_write_receipts', 'run_id'),
      responses: await count('webhook_run_responses', 'run_id'),
      callbacks: await count('pending_run_tasks', 'run_id'),
    };
  }

  it('go a minute past the window and stay a minute inside', async () => {
    const past = await insertRun({ completedAt: ago(30 * DAY + MINUTE) });
    const inside = await insertRun({ completedAt: ago(30 * DAY - MINUTE) });
    await insertFollowers(past);
    await insertFollowers(inside);

    await untilIdle();

    expect(await followers(past)).toEqual({
      receipts: 0,
      responses: 0,
      callbacks: 0,
    });
    expect(await followers(inside)).toEqual({
      receipts: 1,
      responses: 1,
      callbacks: 1,
    });
  });
});

describe('what retention must not delete early', () => {
  it.each(['queued', 'running', 'waiting'])(
    'keeps a %s run, however old, with everything it owns',
    async (status) => {
      const runId = await insertRun({
        status,
        createdAt: ago(400 * DAY),
      });
      await insertDetails(runId);

      await untilIdle();

      expect(await detailCounts(runId)).toEqual(allDetails);
      expect(await summary(runId)).toMatchObject({ details_purged_at: null });
    },
  );

  it('keeps a test run that has not finished past its seven days', async () => {
    const runId = await insertRun({
      triggerType: 'test',
      createdAt: ago(30 * DAY),
    });
    await insertDetails(runId);

    await untilIdle();

    expect(await detailCounts(runId)).toEqual(allDetails);
  });

  it('keeps the summary of a run a replay record still names', async () => {
    const runId = await insertRun({
      completedAt: ago(91 * DAY),
      purged: true,
    });
    const created = new Date();
    await admin.query(`set session_replication_role=replica`);
    await admin.query(
      `insert into app.webhook_trigger_replay_records
        (workspace_id,endpoint_id,dedupe_key_hash,request_fingerprint,delivery_id,
         workflow_run_id,created_at,expires_at)
       values($1,$2,$3,$3,$4,$5,$6,$6::timestamptz+interval '24 hours')`,
      [
        workspaceId,
        randomUUID(),
        randomUUID().replaceAll('-', '').padEnd(64, '0'),
        randomUUID(),
        runId,
        created,
      ],
    );
    await admin.query(`set session_replication_role=origin`);

    await untilIdle();

    expect(await summary(runId)).toBeDefined();
  });

  it('leaves a run another transaction holds, and takes it on a later pass', async () => {
    const runId = await insertRun({ completedAt: ago(31 * DAY) });
    const holder = new Client({ connectionString: withDatabase(adminUrl) });
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(
        'select 1 from app.workflow_runs where id=$1 for update',
        [runId],
      );

      await retention.enforce();
      expect(await summary(runId)).toMatchObject({ details_purged_at: null });

      await holder.query('commit');
      await untilIdle();
      expect(await summary(runId)).toMatchObject({
        details_purged_at: expect.any(Date),
      });
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.end();
    }
  });
});

describe('run detail paging', () => {
  it('removes one run with more rows than a page across passes, and purges it last', async () => {
    const runId = await insertRun({ completedAt: ago(31 * DAY) });
    await insertNodeRun(runId);
    await insertNodeRun(runId);
    await insertNodeRun(runId);

    const first = await retention.enforce();
    expect(first.removed.node_runs).toBe(2);
    expect(first.more).toBe(true);
    expect(await countOf('node_runs', runId)).toBe(1);
    expect(await summary(runId)).toMatchObject({ details_purged_at: null });

    await untilIdle();
    expect(await countOf('node_runs', runId)).toBe(0);
    expect(await summary(runId)).toMatchObject({
      details_purged_at: expect.any(Date),
    });
  });

  it.each([
    ['node_runs', insertNodeRun],
    ['run_events', insertEvent],
    ['run_checkpoints', insertCheckpoint],
  ] as const)(
    'reaches %s of a newer run past a page of older expired runs that have none',
    async (table, insertChild) => {
      // These stay unpurged because of the other two kinds of row, so a page
      // picked without looking at this table would hold only these runs.
      const insertOther =
        table === 'node_runs'
          ? insertEvent
          : (runId: string) => insertNodeRun(runId);
      for (const days of [40, 39, 38]) {
        const older = await insertRun({ completedAt: ago(days * DAY) });
        await insertOther(older);
      }
      const newer = await insertRun({ completedAt: ago(31 * DAY) });
      await insertChild(newer);

      const pass = await retention.enforce();

      expect(pass.removed[table]).toBe(1);
      expect(await countOf(table, newer)).toBe(0);
      await untilIdle();
    },
  );
});

describe('rows found on a run whose details are already purged', () => {
  it('stay until the summary goes, then go with it', async () => {
    const runId = await insertRun({
      completedAt: ago(31 * DAY),
      purged: true,
    });
    await insertDetails(runId);

    await untilIdle();
    expect(await detailCounts(runId)).toEqual(allDetails);

    await admin.query(
      `update app.workflow_runs set completed_at=$2 where id=$1`,
      [runId, ago(91 * DAY)],
    );
    await untilIdle();

    expect(await summary(runId)).toBeUndefined();
    expect(await detailCounts(runId)).toEqual(noDetails);
  });

  it('do not hold back receipts and webhook responses, which go anyway', async () => {
    const runId = await insertRun({
      completedAt: ago(31 * DAY),
      purged: true,
    });
    await admin.query(
      `insert into app.data_table_write_receipts
        (workspace_id,execution_id,invocation_id,run_id,request_hash,result_json)
       values($1,$2,$3,$2,$4,'{}')`,
      [workspaceId, runId, randomUUID(), 'a'.repeat(64)],
    );
    await admin.query(
      `insert into app.webhook_run_responses(run_id,workspace_id,wait_seconds)
       values($1,$2,30)`,
      [runId, workspaceId],
    );

    await untilIdle();

    const receipts = await admin.query(
      'select 1 from app.data_table_write_receipts where run_id=$1',
      [runId],
    );
    const responses = await admin.query(
      'select 1 from app.webhook_run_responses where run_id=$1',
      [runId],
    );
    expect(receipts.rows).toEqual([]);
    expect(responses.rows).toEqual([]);
  });
});

describe('an idle pass', () => {
  // The audit's finding: walking a child table and probing each row's run read
  // all of it when nothing was due. A tenth of the rows is well above what
  // finding no due run reads, and far below walking the table.
  it.each([
    ['node_runs', nodeDetails],
    ['run_events', events],
    ['run_checkpoints', checkpoints],
  ] as const)(
    'reads under a tenth of %s when nothing is due',
    async (table, rule) => {
      await untilIdle();
      const rows = 2_000;
      await admin.query(
        `with runs as (
           insert into app.workflow_runs
             (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
              started_at,completed_at,created_at,updated_at)
           select gen_random_uuid(),$1,gen_random_uuid(),$3::uuid,'manual',
             'succeeded',clock_timestamp(),clock_timestamp(),clock_timestamp(),clock_timestamp()
           from generate_series(1,$2::int)
           returning id
         ), steps as (
           insert into app.node_runs
             (id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
              status,side_effect_class)
           select gen_random_uuid(),$1,id,'node','node','{}','succeeded','safe' from runs
         ), history as (
           insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload)
           select $1,id,1,'run.succeeded','{}' from runs
         )
         insert into app.run_checkpoints
           (workflow_run_id,workspace_id,workflow_version_id,revision,scheduler_state)
         select id,$1,$3::uuid,1,'{}' from runs`,
        [workspaceId, rows, randomUUID()],
      );
      await admin.query(
        'analyze app.workflow_runs, app.node_runs, app.run_events, app.run_checkpoints',
      );
      await admin.query('begin');
      try {
        expect(await rule.run(admin as never, 500)).toBe(0);
        const read = await admin.query<{ tuples: number }>(
          `select (coalesce(seq_tup_read,0)+coalesce(idx_tup_fetch,0))::int tuples
             from pg_stat_xact_user_tables
            where schemaname='app' and relname=$1`,
          [table],
        );
        expect(read.rows[0]?.tuples).toBeLessThan(rows / 10);
      } finally {
        await admin.query('rollback');
      }
    },
    60_000,
  );
});
