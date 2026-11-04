import { randomUUID } from 'node:crypto';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/primitives';
import {
  actorId,
  asAdmin,
  insertRun,
  notificationDestinationId,
  notificationSecretVersionId,
  versionA,
  versionB,
  workflowA,
  workflowB,
  workspaceA,
  workspaceB,
} from '../../runs/run-store/fixtures.js';

export async function seedNotificationDestination() {
  const connectionId = randomUUID(),
    secretId = randomUUID(),
    destinationId = randomUUID();
  await asAdmin(async (client) => {
    await client.query('begin');
    try {
      await client.query(`set constraints all deferred`);
      await client.query(
        `insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by)
        values($1,$2,'email','Recovery destination','resend_api_key','active',$3,$4)`,
        [connectionId, workspaceB, secretId, actorId],
      );
      await client.query(
        `insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
        values($1,$2,$3,'kms','key','cipher','AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA',$4)`,
        [secretId, workspaceB, connectionId, actorId],
      );
      await client.query(
        `insert into app.failure_notification_destinations(id,workspace_id,kind,status,current_config_version,created_by)
        values($1,$2,'email','enabled',1,$3)`,
        [destinationId, workspaceB, actorId],
      );
      await client.query(
        `insert into app.failure_notification_destination_versions(workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
        values($1,$2,1,'email','idempotent_with_key',$3,$4)`,
        [
          workspaceB,
          destinationId,
          { connectionId, toEmail: 'recovery@example.test' },
          actorId,
        ],
      );
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    }
  });
  return { destinationId, secretId };
}

export type NoticeState = Readonly<{
  status: 'claimed' | 'dispatching';
  sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe';
  attempts: number;
  unresolved?: boolean;
}>;
export async function seedNotice(
  state: NoticeState,
  other?: Awaited<ReturnType<typeof seedNotificationDestination>>,
) {
  const workspaceId = other === undefined ? workspaceA : workspaceB;
  const workflowId = other === undefined ? workflowA : workflowB;
  const versionId = other === undefined ? versionA : versionB;
  const destinationId = other?.destinationId ?? notificationDestinationId;
  const secretId = other?.secretId ?? notificationSecretVersionId;
  const runId = await insertRun({
    workspaceId,
    workflowId,
    workflowVersionId: versionId,
    status: 'running',
    failureNotificationPolicy: {
      destinationId,
      destinationConfigVersion: 1,
      sideEffectClass: state.sideEffectClass,
      connectionSecretVersionId: secretId,
    },
  });
  const id = randomUUID();
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
  await asAdmin(async (client) => {
    await client.query('begin');
    try {
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await client.query(
        "update app.workflow_runs set status='failed',completed_at=clock_timestamp() where id=$1",
        [runId],
      );
      await client.query(
        `insert into app.run_failure_notification_intents(id,workspace_id,workflow_run_id,terminal_event_sequence,destination_id,destination_config_version,
        side_effect_class,context,context_checksum,status,delivery_attempts,dispatch_marked_at,recovery_at,possibly_dispatched,connection_secret_version_id)
        values($1,$2,$3,2,$4,1,$5,$6,$7,$8::varchar,$9,case when $8::varchar='dispatching' then clock_timestamp()-interval '1 minute' end,
        clock_timestamp()-interval '1 second',$10,$11)`,
        [
          id,
          workspaceId,
          runId,
          destinationId,
          state.sideEffectClass,
          context,
          canonicalOutboxPayloadChecksum(context),
          state.status,
          state.attempts,
          state.unresolved ?? false,
          secretId,
        ],
      );
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    }
  });
  return { id, workspaceId, runId };
}
export async function noticeFacts(id: string) {
  return asAdmin(async (client) => ({
    intent: (
      await client.query(
        `select status,safe_error_code,possibly_dispatched,delivery_attempts,
      dispatch_marked_at is null dispatch_cleared,recovery_at is null recovery_cleared,
      next_delivery_at is not null retry_due,completed_at is not null completed
      from app.run_failure_notification_intents where id=$1`,
        [id],
      )
    ).rows[0] as unknown,
    audit: (
      await client.query(
        `select fact_type,attempt_number,safe_error_code,possibly_dispatched
      from app.run_failure_notification_audit_facts where notification_intent_id=$1 order by occurred_at,id`,
        [id],
      )
    ).rows,
    outbox: (
      await client.query<{
        id: string;
        workspace_id: string;
        payload: unknown;
        payload_checksum: string;
      }>(
        `select id,workspace_id,payload,payload_checksum from app.outbox_events where aggregate_id=$1 order by created_at,id`,
        [id],
      )
    ).rows,
  }));
}
