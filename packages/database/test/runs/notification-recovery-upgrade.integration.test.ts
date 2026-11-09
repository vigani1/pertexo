import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalOutboxPayloadChecksum } from '../../src/primitives.js';
import {
  seedWorkflow,
  withDatabase,
} from '../platform/migrations/upgrade-fixture.js';

it('retains a possibly dispatched notification on upgrade and exposes only a locked storage claim across workspaces', async () => {
  await withDatabase(async ({ admin }) => {
    const { ownerId, workspaceId, workflowId } = await seedWorkflow(admin);
    const versionId = randomUUID(),
      connectionId = randomUUID(),
      secretId = randomUUID(),
      destinationId = randomUUID();
    const runId = randomUUID(),
      intentId = randomUUID(),
      outboxId = randomUUID();
    const context = {
      runId,
      workflowId,
      workflowVersionId: versionId,
      terminalEventSequence: 2,
      terminalStatus: 'failed',
      triggerType: 'manual',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
      primaryFailure: {
        source: 'run',
        runStatus: 'failed',
        safeErrorCode: 'execution.run_state_invalid',
      },
      totalFailureCount: 1,
    };
    const payload = {
      workspaceId,
      notificationIntentId: intentId,
      outboxEventId: outboxId,
    };
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
        values($1,$2,$3,1,'{}',$4,'{}',$5)`,
        [
          versionId,
          workspaceId,
          workflowId,
          `wf:sha256:${'a'.repeat(64)}`,
          ownerId,
        ],
      );
      await client.query(
        `insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by)
        values($1,$2,'email','Recovery destination','resend_api_key','active',$3,$4)`,
        [connectionId, workspaceId, secretId, ownerId],
      );
      await client.query(
        `insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
        values($1,$2,$3,'kms','key','cipher','AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA',$4)`,
        [secretId, workspaceId, connectionId, ownerId],
      );
      await client.query(
        `insert into app.failure_notification_destinations(id,workspace_id,kind,status,current_config_version,created_by)
        values($1,$2,'email','enabled',1,$3)`,
        [destinationId, workspaceId, ownerId],
      );
      await client.query(
        `insert into app.failure_notification_destination_versions(workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
        values($1,$2,1,'email','idempotent_with_key',$3,$4)`,
        [
          workspaceId,
          destinationId,
          { connectionId, toEmail: 'recovery@example.test' },
          ownerId,
        ],
      );
      await client.query(
        `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,status,trigger_type,completed_at,
        failure_notification_destination_id,failure_notification_destination_config_version,failure_notification_side_effect_class,failure_notification_connection_secret_version_id)
        values($1,$2,$3,$4,'failed','manual',clock_timestamp(),$5,1,'idempotent_with_key',$6)`,
        [runId, workspaceId, workflowId, versionId, destinationId, secretId],
      );
      await client.query(
        `insert into app.run_failure_notification_intents(id,workspace_id,workflow_run_id,terminal_event_sequence,destination_id,destination_config_version,
        side_effect_class,context,context_checksum,status,delivery_attempts,dispatch_marked_at,recovery_at,possibly_dispatched,connection_secret_version_id)
        values($1,$2,$3,2,$4,1,'idempotent_with_key',$5,$6,'dispatching',1,clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 second',true,$7)`,
        [
          intentId,
          workspaceId,
          runId,
          destinationId,
          context,
          canonicalOutboxPayloadChecksum(context),
          secretId,
        ],
      );
      await client.query(
        `insert into app.outbox_events(id,workspace_id,aggregate_type,aggregate_id,job_name,payload,payload_checksum,published_at)
        values($1,$2,'run-failure-notification',$3,'deliver-run-failure-notification',$4,$5,clock_timestamp())`,
        [
          outboxId,
          workspaceId,
          intentId,
          payload,
          canonicalOutboxPayloadChecksum(payload),
        ],
      );
      await client.query('commit');
      const retained = async () => ({
        intent: (
          await client.query(
            'select to_jsonb(i) state from app.run_failure_notification_intents i where id=$1',
            [intentId],
          )
        ).rows,
        outbox: (
          await client.query(
            'select to_jsonb(e) state from app.outbox_events e where id=$1',
            [outboxId],
          )
        ).rows,
      });
      const before = await retained();

      expect(await retained()).toEqual(before);
      await client.query('begin');
      await client.query('set local role pertexo_app');
      expect(
        (
          await client.query(
            'select id from app.run_failure_notification_intents',
          )
        ).rows,
      ).toEqual([]);
      await expect(
        client.query(
          'select * from app.claim_due_run_failure_notification_recoveries(10)',
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback');
      await client.query('begin');
      await client.query('set local role pertexo_maintenance');
      expect(
        (
          await client.query(
            'select * from app.claim_due_run_failure_notification_recoveries(10)',
          )
        ).rows,
      ).toEqual([
        {
          id: intentId,
          workspace_id: workspaceId,
          status: 'dispatching',
          delivery_attempts: 1,
          side_effect_class: 'idempotent_with_key',
          possibly_dispatched: true,
        },
      ]);
      await client.query('rollback');
      expect(await retained()).toEqual(before);
      await client.query('begin');
      await client.query('set local role pertexo_app');
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      expect(
        (
          await client.query(
            'select status,safe_error_code from app.run_failure_notification_intents where id=$1',
            [intentId],
          )
        ).rows,
      ).toEqual([{ status: 'dispatching', safe_error_code: null }]);
      await client.query('rollback');
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
}, 60000);
