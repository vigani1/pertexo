import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimOutboxBatch } from '../../../src/outbox/dispatcher/claim.js';
import { useInstanceCapacity } from '../../support/instance-capacity.js';
import {
  admin,
  createFamily,
  insertHint,
} from '../../lifecycle/calls/calls.fixture.js';
import { adminUrl, withDatabase } from '../../lifecycle/retention.support.js';
import {
  afterAllFixture2,
  beforeAllFixture1,
  lend,
  setStatus,
  takeBack,
  usage,
} from './calls-capacity.fixture.js';

const WORKSPACE_LIMIT = 3;

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
let dispatcher!: Pool;
beforeAll(async () => {
  dispatcher = new Pool({ connectionString: withDatabase(adminUrl), max: 1 });
  const client = await dispatcher.connect();
  try {
    await client.query('set role pertexo_maintenance');
  } finally {
    client.release();
  }
});
afterAll(() => dispatcher.end());

describe('a Call child behind a backlog in a full workspace', () => {
  useInstanceCapacity(
    {
      activeRunLimit: WORKSPACE_LIMIT,
      queuedRunLimit: 1_000,
      artifactCountLimit: 1_000,
    },
    withDatabase(adminUrl),
  );

  it('runs on the lent slot, then gives the backlog the next free slot, admitting nothing twice', async () => {
    // The waiting parent holds one slot and two running runs the others.
    const family = await createFamily({ childQueued: true });
    const ws = family.workspaceId;
    const workflow = {
      workflowId: family.childWorkflowId,
      versionId: family.childVersionId,
    };
    const running = [
      await insertRun(ws, { ...workflow, status: 'running' }),
      await insertRun(ws, { ...workflow, status: 'running' }),
    ];
    // Queued before the child, so the backlog is ahead of it in delivery order.
    const backlog: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const runId = await insertRun(ws, { ...workflow, status: 'queued' });
      await insertHint(ws, runId);
      backlog.push(runId);
    }
    const granted: string[] = [];
    const claim = async () => {
      const runIds = await claimRuns();
      granted.push(...runIds);
      expect(
        (await usage(ws)).activeCapacityConsumed,
        'occupied slots after a claim',
      ).toBeLessThanOrEqual(WORKSPACE_LIMIT);
      return runIds;
    };

    expect(await claim()).toEqual([]);

    expect(await lend(family)).toBe(true);
    expect(await claim()).toEqual([family.childRunId]);
    await setStatus(ws, family.childRunId, 'running');
    expect(await claim()).toEqual([]);

    await setStatus(ws, family.childRunId, 'succeeded');
    expect(await claim()).toEqual([]);
    // The loan comes back to the parent, which holds the slot again: only its
    // own resume is delivered, and the backlog still waits.
    expect(await takeBack(family)).toBe(true);
    expect(await claim()).toEqual([family.parentRunId]);
    expect(await claim()).toEqual([]);

    // Each freed slot goes to the backlog's next run, one at a time.
    await setStatus(ws, family.parentRunId, 'succeeded');
    expect(await claim()).toEqual([backlog[0]]);
    await setStatus(ws, running[0] ?? '', 'succeeded');
    expect(await claim()).toEqual([backlog[1]]);
    expect(await claim()).toEqual([]);

    expect(new Set(granted).size).toBe(granted.length);
  });
});

async function claimRuns(): Promise<string[]> {
  const batch = await claimOutboxBatch(dispatcher, {
    enabledJobNames: ['advance-workflow-run'],
    leaseDurationMillis: 30_000,
    leaseOwner: 'lending-backlog',
    leaseToken: randomUUID(),
    limit: 25,
  });
  for (const event of batch.events)
    await admin.query(
      'update app.outbox_events set published_at=clock_timestamp(),lease_expires_at=null,lease_owner=null,lease_token=null where id=$1',
      [event.id],
    );
  return batch.events.map((event) => event.aggregateId);
}

async function insertRun(
  workspaceId: string,
  run: Readonly<{ workflowId: string; versionId: string; status: string }>,
): Promise<string> {
  const id = randomUUID();
  await admin.query("select set_config('app.workspace_id',$1,false)", [
    workspaceId,
  ]);
  await admin.query(
    `insert into app.workflow_runs
       (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,input_ref,input_ref_expires_at)
     values($1,$2,$3,$4,'manual',$5,$6::jsonb,clock_timestamp()+interval '29 days')`,
    [
      id,
      workspaceId,
      run.workflowId,
      run.versionId,
      run.status,
      JSON.stringify({ kind: 'inline', value: { input: id } }),
    ],
  );
  return id;
}
