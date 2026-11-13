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
  lowerLimit,
} from './calls-capacity.fixture.js';

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

describe('admission across entitlement versions', () => {
  useInstanceCapacity(
    { activeRunLimit: 3, queuedRunLimit: 1_000, artifactCountLimit: 1_000 },
    withDatabase(adminUrl),
  );

  it('admits runs pinned to a higher limit past runs pinned to a lower one', async () => {
    // Two runs hold slots, so a limit of 3 leaves one free and a limit of 5 three.
    const family = await createFamily();
    const ws = family.workspaceId;
    const queue = async () => {
      const runId = await insertQueuedRun(
        ws,
        family.childWorkflowId,
        family.childVersionId,
      );
      await insertHint(ws, runId);
      return runId;
    };
    const lower = [await queue(), await queue(), await queue()];
    await lowerLimit(ws, 2, 5);
    const higher = [await queue(), await queue(), await queue()];

    // Each run is admitted under its own pinned limit, in delivery order.
    expect(await claim()).toEqual([lower[0], higher[0], higher[1]]);
  });
});

async function claim(): Promise<string[]> {
  const batch = await claimOutboxBatch(dispatcher, {
    enabledJobNames: ['advance-workflow-run'],
    leaseDurationMillis: 30_000,
    leaseOwner: 'mixed-limits',
    leaseToken: randomUUID(),
    limit: 25,
  });
  return batch.events.map((event) => event.aggregateId);
}

async function insertQueuedRun(
  workspaceId: string,
  workflowId: string,
  versionId: string,
): Promise<string> {
  const id = randomUUID();
  await admin.query("select set_config('app.workspace_id',$1,false)", [
    workspaceId,
  ]);
  await admin.query(
    `insert into app.workflow_runs
       (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,input_ref,input_ref_expires_at)
     values($1,$2,$3,$4,'manual','queued',$5::jsonb,clock_timestamp()+interval '29 days')`,
    [
      id,
      workspaceId,
      workflowId,
      versionId,
      JSON.stringify({ kind: 'inline', value: { input: id } }),
    ],
  );
  return id;
}
