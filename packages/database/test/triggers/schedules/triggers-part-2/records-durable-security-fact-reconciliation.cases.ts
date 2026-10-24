import { ownerQuery, workflowId, workspaceId } from './fixture.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { canonicalOutboxPayloadChecksum } from '../../../../src/outbox/events.repository.js';

import { schedule } from './fixture.js';

export function registerRecordsDurableSecurityFactReconciliation(): void {
  it('records a durable security fact for reconciliation checksum mismatches without reapplying the trigger', async () => {
    const current = await ownerQuery<{ published_version_id: string }>(
      'select published_version_id from app.workflows where id=$1',
      [workflowId],
    );
    const publishedVersionId = current.rows[0]?.published_version_id;
    if (publishedVersionId === undefined)
      throw new Error('Current publication missing');
    const outboxEventId = randomUUID();
    const payload = {
      workspaceId,
      outboxEventId,
      workflowId,
      publishedVersionId,
    };
    const payloadChecksum = canonicalOutboxPayloadChecksum(payload);
    await ownerQuery(
      `insert into app.outbox_events (
         id,workspace_id,job_name,aggregate_type,
         aggregate_id,payload,payload_checksum
       ) values ($1,$2,'reconcile-workflow-triggers','workflow',$3,$4::jsonb,$5)`,
      [
        outboxEventId,
        workspaceId,
        workflowId,
        JSON.stringify(payload),
        payloadChecksum,
      ],
    );
    const command = {
      workspaceId,
      workflowId,
      publishedVersionId,
      outboxEventId,
      delivery: { outboxEventId, payloadChecksum },
    };
    await schedule.reconciliation.reconcile(command);
    await expect(
      schedule.reconciliation.reconcile({
        ...command,
        delivery: { outboxEventId, payloadChecksum: '0'.repeat(64) },
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowTriggerReconciliationMismatchError',
    });
    const evidence = await ownerQuery<{ facts: string }>(
      `select count(*) facts from app.transport_security_audit_facts
        where consumer_name='trigger-runtime.reconciliation'
          and message_id=$1`,
      [outboxEventId],
    );
    expect(evidence.rows[0]).toEqual({ facts: '1' });
    await expect(schedule.reconciliation.reconcile(command)).resolves.toEqual(
      [],
    );

    const conflictingId = randomUUID();
    const conflictingPayload = { ...payload, outboxEventId: conflictingId };
    await ownerQuery(
      `insert into app.outbox_events (
         id,workspace_id,job_name,aggregate_type,
         aggregate_id,payload,payload_checksum
       ) values ($1,$2,'reconcile-workflow-triggers','workflow',$3,$4::jsonb,$5)`,
      [
        conflictingId,
        workspaceId,
        workflowId,
        JSON.stringify(conflictingPayload),
        canonicalOutboxPayloadChecksum(conflictingPayload),
      ],
    );
    const api = new Pool({
      connectionString: schedule.apiConnectionString,
      max: 1,
    });
    try {
      const client = await api.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await client.query(
          `insert into app.inbox_receipts (
             consumer_name,message_id,workspace_id,payload_checksum,completed_at
           ) values ('trigger-runtime.reconciliation',$1,$2,$3,clock_timestamp())`,
          [conflictingId, workspaceId, '1'.repeat(64)],
        );
        await client.query('commit');
      } catch (error: unknown) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    } finally {
      await api.end();
    }
    await expect(
      schedule.reconciliation.reconcile({
        ...command,
        outboxEventId: conflictingId,
        delivery: {
          outboxEventId: conflictingId,
          payloadChecksum: canonicalOutboxPayloadChecksum(conflictingPayload),
        },
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowTriggerReconciliationMismatchError',
    });
    const second = await ownerQuery<{ facts: string }>(
      `select count(*) facts from app.transport_security_audit_facts
        where consumer_name='trigger-runtime.reconciliation' and message_id=$1`,
      [conflictingId],
    );
    expect(second.rows[0]?.facts).toBe('1');
  });
}
