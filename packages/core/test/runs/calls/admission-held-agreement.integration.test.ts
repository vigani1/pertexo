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
} from './calls-capacity.fixture.js';

// The claim skips the deliveries `held_workflow_run_admission_events` lists and
// never asks eligibility about them. That is only safe while eligibility would
// refuse every one of them; this pins the two definitions together.
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

describe('held admission deliveries', () => {
  useInstanceCapacity(
    { activeRunLimit: 7, queuedRunLimit: 1_000, artifactCountLimit: 1_000 },
    withDatabase(adminUrl),
  );

  it('holds only deliveries that eligibility refuses', async () => {
    // A lent child (borrowed slot) and its lending parent.
    const family = await createFamily({ childQueued: true });
    const ws = family.workspaceId;
    const unlimited = family.childWorkflowId;
    const unlimitedVersion = family.childVersionId;
    // A second family's child workflow is the limited one.
    const limitedFamily = await createFamily({ workspaceId: ws });
    const limited = limitedFamily.childWorkflowId;
    const limitedVersion = limitedFamily.childVersionId;
    await admin.query(
      'insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit) values($1,$2,2)',
      [ws, limited],
    );

    for (let index = 0; index < 2; index += 1)
      await insertRun(ws, unlimited, unlimitedVersion, 'running');
    const limitedRuns: string[] = [];
    for (let index = 0; index < 4; index += 1)
      limitedRuns.push(await queuedWithDelivery(ws, limited, limitedVersion));
    const unlimitedRuns: string[] = [];
    for (let index = 0; index < 4; index += 1)
      unlimitedRuns.push(
        await queuedWithDelivery(ws, unlimited, unlimitedVersion),
      );
    const canceled = await queuedWithDelivery(ws, unlimited, unlimitedVersion);
    await admin.query(
      "update app.workflow_runs set cancel_requested_at=clock_timestamp(),cancel_requested_by='test' where id=$1",
      [canceled],
    );
    await queuedWithDelivery(ws, unlimited, unlimitedVersion, {
      expired: true,
    });
    await queuedWithDelivery(ws, limited, limitedVersion, { expired: true });
    expect(await lend(family)).toBe(true);
    await insertHint(ws, family.parentRunId);

    // One claim leaves reserved runs behind, then fresh deliveries for them.
    const reserved = await claim();
    // The workspace fills: the lent child, the limited head and one unlimited run.
    expect(reserved).toEqual(
      expect.arrayContaining([
        family.childRunId,
        limitedRuns[0],
        unlimitedRuns[0],
      ]),
    );
    for (const runId of reserved) await insertHint(ws, runId);

    const held = await heldDeliveries(ws);
    const heldRuns = held.map(({ runId }) => runId);
    // Behind the limited queue's head, and the unlimited runs past the free slots.
    expect(heldRuns).toEqual(
      expect.arrayContaining([
        limitedRuns[2],
        limitedRuns[3],
        ...unlimitedRuns.slice(1),
      ]),
    );
    expect(heldRuns).not.toContain(limitedRuns[1]);
    expect(heldRuns).not.toContain(canceled);
    expect(heldRuns).not.toContain(family.childRunId);
    for (const delivery of held)
      expect(
        await eligible(ws, delivery.eventId, delivery.runId),
        `held delivery ${delivery.eventId}`,
      ).toBe(false);
  });
});

async function claim(): Promise<string[]> {
  const batch = await claimOutboxBatch(dispatcher, {
    enabledJobNames: ['advance-workflow-run'],
    leaseDurationMillis: 30_000,
    leaseOwner: 'held-agreement',
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

async function heldDeliveries(workspaceId: string) {
  const result = await dispatcher.query<{ eventId: string; runId: string }>(
    `select held.event_id "eventId", event.aggregate_id "runId"
       from app.held_workflow_run_admission_events($1) held(event_id)
       join app.outbox_events event on event.id=held.event_id`,
    [workspaceId],
  );
  return result.rows;
}

async function eligible(workspaceId: string, eventId: string, runId: string) {
  const client = await dispatcher.connect();
  try {
    await client.query('begin');
    // As the claim sets it, so limited workflows are judged by their limit.
    await client.query(
      "select set_config('app.workflow_concurrency_protocol','1',true)",
    );
    const result = await client.query<{ eligible: boolean }>(
      'select app.workflow_run_active_admission_eligible($1,$2,$3) eligible',
      [workspaceId, eventId, runId],
    );
    return result.rows[0]?.eligible;
  } finally {
    await client.query('rollback');
    client.release();
  }
}

async function queuedWithDelivery(
  workspaceId: string,
  workflowId: string,
  versionId: string,
  options: Readonly<{ expired?: boolean }> = {},
): Promise<string> {
  const runId = await insertRun(
    workspaceId,
    workflowId,
    versionId,
    'queued',
    options.expired === true,
  );
  await insertHint(workspaceId, runId);
  return runId;
}

async function insertRun(
  workspaceId: string,
  workflowId: string,
  versionId: string,
  status: string,
  expired = false,
): Promise<string> {
  const id = randomUUID();
  await admin.query("select set_config('app.workspace_id',$1,false)", [
    workspaceId,
  ]);
  await admin.query(
    `insert into app.workflow_runs
       (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,input_ref,input_ref_expires_at,created_at,deadline_at)
     values($1,$2,$3,$4,'manual',$5,$6::jsonb,clock_timestamp()+interval '29 days',clock_timestamp()-interval '1 hour',
       case when $7 then clock_timestamp()-interval '1 minute' end)`,
    [
      id,
      workspaceId,
      workflowId,
      versionId,
      status,
      JSON.stringify({ kind: 'inline', value: { input: id } }),
      expired,
    ],
  );
  return id;
}
