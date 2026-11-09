import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalOutboxPayloadChecksum } from '../../src/primitives.js';
import {
  seedWorkflow,
  withDatabase,
} from '../platform/migrations/upgrade-fixture.js';

it('keeps populated error-handler intent identity and makes its failed delivery recoverable on upgrade', async () => {
  await withDatabase(async ({ admin }) => {
    const { ownerId, workspaceId, workflowId } = await seedWorkflow(admin);
    const versionId = randomUUID(),
      runId = randomUUID(),
      eventId = randomUUID();
    await admin.query(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
      values($1,$2,$3,1,'{"settings":{},"nodes":[],"edges":[]}',$4,'{}',$5)`,
      [
        versionId,
        workspaceId,
        workflowId,
        `wf:sha256:${'a'.repeat(64)}`,
        ownerId,
      ],
    );
    const writer = await admin.connect();
    try {
      await writer.query('begin');
      await writer.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await writer.query(
        `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,completed_at)
        values($1,$2,$3,$4,'manual','failed',clock_timestamp())`,
        [runId, workspaceId, workflowId, versionId],
      );
      await writer.query('commit');
    } finally {
      await writer.query('rollback');
      writer.release();
    }
    const payload = { workspaceId, sourceRunId: runId, outboxEventId: eventId };
    const checksum = canonicalOutboxPayloadChecksum(payload);
    await admin.query(
      `insert into app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum,failed_at,delivery_due_at,last_error_code)
      values($1,$2,'start-error-workflow','workflow-run',$3,$4,$5,clock_timestamp(),clock_timestamp(),'delivery.never_confirmed')`,
      [eventId, workspaceId, runId, payload, checksum],
    );
    await admin.query(
      `insert into app.run_error_workflow_intents(workspace_id,source_run_id,target_workflow_id,target_version_id,context,outbox_event_id)
      values($1,$2,$3,$4,'{"retained":"error context"}',$5)`,
      [workspaceId, runId, workflowId, versionId, eventId],
    );
    const before = (
      await admin.query(
        'select to_jsonb(i) state from app.run_error_workflow_intents i where source_run_id=$1',
        [runId],
      )
    ).rows;

    expect(
      (
        await admin.query(
          'select to_jsonb(i) state from app.run_error_workflow_intents i where source_run_id=$1',
          [runId],
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await admin.query(
          `select payload,payload_checksum,delivery_due_at is not null repair_due,last_error_code from app.outbox_events where id=$1`,
          [eventId],
        )
      ).rows,
    ).toEqual([
      {
        payload,
        payload_checksum: checksum,
        repair_due: true,
        last_error_code: 'delivery.never_confirmed',
      },
    ]);
    const client = await admin.connect();
    await client.query('begin');
    try {
      await client.query('set local role pertexo_maintenance');
      // Recovery may replace the delivery pointer; it cannot rewrite the target.
      await expect(
        client.query(
          'update app.run_error_workflow_intents set target_workflow_id=$1 where source_run_id=$2',
          [workflowId, runId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
}, 60_000);
