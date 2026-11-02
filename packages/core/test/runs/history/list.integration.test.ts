import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorkflowRunDatabase } from '../../../src/runs/store.js';
import {
  actorId,
  apiUrl,
  workspaceId,
} from '../../support/workflow-authoring.js';
import {
  builder,
  closeWorld,
  hiddenFolderId,
  moveIntoFolder,
  openWorld,
  publishedWorkflow,
  type Target,
} from '../../authoring/workflows/access/world.js';

const MINUTE = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE);

let seeder!: Client;
let runs: ReturnType<typeof createWorkflowRunDatabase>;
let nextTicket = 1_000;

type Seed = Readonly<{
  at: Date;
  status?: string;
  values?: Readonly<Record<string, string>>;
}>;

/** Only the seeding skips admission's triggers: a list reads what's stored. */
async function seedRun(
  workflow: Target,
  { at, status = 'succeeded', values = {} }: Seed,
): Promise<string> {
  const id = randomUUID();
  const finished = status !== 'queued' && status !== 'running';
  await seeder.query(
    `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,
       status,admission_ticket,created_at,updated_at,started_at,completed_at)
     values($1,$2,$3,$4,'manual',$5,$6,$7::timestamptz,$7::timestamptz,$8::timestamptz,$9::timestamptz)`,
    [
      id,
      workspaceId,
      workflow.id,
      workflow.versionId,
      status,
      (nextTicket += 1),
      at,
      status === 'queued' ? null : at,
      finished ? at : null,
    ],
  );
  for (const [key, value] of Object.entries(values))
    await seeder.query(
      `insert into app.workflow_run_values(id,workspace_id,workflow_run_id,key,value)
       values(gen_random_uuid(),$1,$2,$3,$4)`,
      [workspaceId, id, key, value],
    );
  return id;
}

const list = (filters: Readonly<Record<string, unknown>> = {}) =>
  runs.list({
    workspaceId,
    actorId,
    limit: 50,
    includeWorkflowName: true,
    ...filters,
  });

const ids = async (filters: Readonly<Record<string, unknown>>) =>
  (await list(filters)).items.map(({ id }) => id);

const storedAt = async (runId: string): Promise<string> => {
  const { rows } = await seeder.query<{ at: string }>(
    `select to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "at"
       from app.workflow_runs where id=$1`,
    [runId],
  );
  return rows[0]?.at ?? '';
};

beforeAll(async () => {
  await openWorld();
  runs = createWorkflowRunDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 3 }),
  );
  const adminUrl = new URL(
    process.env.DATABASE_ADMIN_URL ??
      'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
  );
  adminUrl.pathname = new URL(apiUrl).pathname;
  seeder = new Client({ connectionString: adminUrl.toString() });
  await seeder.connect();
  await seeder.query(`set session_replication_role=replica`);
}, 60_000);

afterAll(async () => {
  await seeder.end();
  await runs.close();
  await closeWorld();
});

describe('filtering the run list by a workflow’s name', () => {
  let upper: Target;
  let lower: Target;
  let other: Target;
  const mine: Record<string, string> = {};

  beforeAll(async () => {
    upper = await publishedWorkflow('Invoice sync');
    lower = await publishedWorkflow('invoice archive');
    other = await publishedWorkflow('Refunds about invoices');
    mine.oldestUpper = await seedRun(upper, { at: ago(50), status: 'failed' });
    mine.lower = await seedRun(lower, {
      at: ago(40),
      status: 'failed',
      values: { orderId: 'A-1' },
    });
    mine.other = await seedRun(other, { at: ago(30), status: 'failed' });
    mine.newestUpper = await seedRun(upper, {
      at: ago(20),
      values: { orderId: 'A-1' },
    });
    mine.newestLower = await seedRun(lower, {
      at: ago(10),
      values: { orderId: 'B-2' },
    });
  }, 60_000);

  it('takes names that start with it, in any case, newest first', async () => {
    await expect(ids({ workflowNamePrefix: 'INVOICE' })).resolves.toEqual([
      mine.newestLower,
      mine.newestUpper,
      mine.lower,
      mine.oldestUpper,
    ]);
    await expect(ids({ workflowNamePrefix: 'nvoice' })).resolves.toEqual([]);
  });

  it('names the workflow on each run it returns', async () => {
    const { items } = await list({ workflowNamePrefix: 'invoice s' });
    expect(items.map(({ workflowName }) => workflowName)).toEqual([
      'Invoice sync',
      'Invoice sync',
    ]);
  });

  it('applies a status with it', async () => {
    await expect(
      ids({ workflowNamePrefix: 'invoice', status: 'failed' }),
    ).resolves.toEqual([mine.lower, mine.oldestUpper]);
  });

  it('applies a date range with it, from inclusive and before exclusive', async () => {
    await expect(
      ids({
        workflowNamePrefix: 'invoice',
        createdAtFrom: await storedAt(mine.lower ?? ''),
        createdAtBefore: await storedAt(mine.newestUpper ?? ''),
      }),
    ).resolves.toEqual([mine.lower]);
  });

  it('applies a run value with it, on the exact pair', async () => {
    await expect(
      ids({
        workflowNamePrefix: 'invoice',
        runValueKey: 'orderId',
        runValue: 'A-1',
      }),
    ).resolves.toEqual([mine.newestUpper, mine.lower]);
    await expect(
      ids({
        workflowNamePrefix: 'refunds',
        runValueKey: 'orderId',
        runValue: 'A-1',
      }),
    ).resolves.toEqual([]);
  });

  it('pages through every match once, across workflows', async () => {
    const seen: string[] = [];
    let after: unknown;
    for (;;) {
      const page: Awaited<ReturnType<typeof list>> = await list({
        workflowNamePrefix: 'invoice',
        limit: 3,
        ...(after === undefined ? {} : { after }),
      });
      seen.push(...page.items.map(({ id }) => id));
      after = page.nextCursor;
      if (after === undefined) break;
    }
    expect(seen).toEqual([
      mine.newestLower,
      mine.newestUpper,
      mine.lower,
      mine.oldestUpper,
    ]);
  });

  // Each workflow is walked newest first for speed. A status applied only afterwards
  // would find these three, and nothing to show.
  it('finds an older match under a page of a workflow’s newer runs', async () => {
    const busy = await publishedWorkflow('Busy paging');
    const failed = await seedRun(busy, { at: ago(45), status: 'failed' });
    for (let index = 0; index < 3; index += 1)
      await seedRun(busy, { at: ago(5 + index) });

    const first = await list({
      workflowNamePrefix: 'busy',
      status: 'failed',
      limit: 2,
    });

    expect(first.items.map(({ id }) => id)).toEqual([failed]);
    expect(first.nextCursor).toBeUndefined();
  });

  it('keeps runs from one instant apart across a page break', async () => {
    const tied = await publishedWorkflow('Tied paging');
    const at = ago(15);
    const expected = [
      await seedRun(tied, { at }),
      await seedRun(tied, { at }),
      await seedRun(tied, { at }),
    ];

    const first = await list({ workflowNamePrefix: 'tied', limit: 2 });
    const second = await list({
      workflowNamePrefix: 'tied',
      limit: 2,
      after: first.nextCursor,
    });

    const seen = [...first.items, ...second.items].map(({ id }) => id);
    expect([...seen].sort()).toEqual([...expected].sort());
    expect(second.nextCursor).toBeUndefined();
  });

  it('reads %, _ and \\ as themselves', async () => {
    const percent = await publishedWorkflow('100% done');
    const words = await publishedWorkflow('100 percent done');
    const underscore = await publishedWorkflow('a_b report');
    const letter = await publishedWorkflow('axb report');
    const slash = await publishedWorkflow('c\\d report');
    const percentRun = await seedRun(percent, { at: ago(9) });
    await seedRun(words, { at: ago(8) });
    const underscoreRun = await seedRun(underscore, { at: ago(7) });
    await seedRun(letter, { at: ago(6) });
    const slashRun = await seedRun(slash, { at: ago(5) });

    await expect(ids({ workflowNamePrefix: '100%' })).resolves.toEqual([
      percentRun,
    ]);
    await expect(ids({ workflowNamePrefix: 'a_b' })).resolves.toEqual([
      underscoreRun,
    ]);
    await expect(ids({ workflowNamePrefix: 'c\\' })).resolves.toEqual([
      slashRun,
    ]);
    await expect(ids({ workflowNamePrefix: '%' })).resolves.toEqual([]);
    await expect(ids({ workflowNamePrefix: '_' })).resolves.toEqual([]);
  });

  it('keeps a workflow outside someone’s folders out of their list, under any filter', async () => {
    const secret = await publishedWorkflow('Secret payroll');
    await moveIntoFolder(secret.id, hiddenFolderId);
    const run = await seedRun(secret, {
      at: ago(3),
      values: { orderId: 'S-1' },
    });
    const forBuilder = (filters: Readonly<Record<string, unknown>>) =>
      ids({ actorId: builder, ...filters });

    await expect(ids({ workflowNamePrefix: 'secret' })).resolves.toEqual([run]);
    await expect(forBuilder({ workflowNamePrefix: 'secret' })).resolves.toEqual(
      [],
    );
    await expect(
      forBuilder({ runValueKey: 'orderId', runValue: 'S-1' }),
    ).resolves.toEqual([]);
    await expect(forBuilder({})).resolves.not.toContain(run);
    // A name that does match stays in view beside it.
    await expect(
      forBuilder({ workflowNamePrefix: 'invoice' }),
    ).resolves.toContain(mine.newestUpper);
  });
});
