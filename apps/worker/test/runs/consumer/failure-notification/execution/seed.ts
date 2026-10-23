import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import {
  acceptRun,
  terminalizeFailedRun,
} from '../../../../support/coordinator/runs.js';
import {
  actorId,
  adminUrl,
  apiQuery,
  databaseUrl,
  workerQuery,
  workflowId,
  workspaceId,
} from '../fixture.js';

export async function seedFailureNotificationProof() {
  const destinationId = randomUUID();
  const connectionId = randomUUID();
  const secretVersionId = randomUUID();
  const slackDestinationId = randomUUID();
  const slackConnectionId = randomUUID();
  const slackSecretVersionId = randomUUID();
  const fixturePool = new Pool({
    connectionString: databaseUrl(adminUrl),
    max: 1,
  });
  try {
    await fixturePool.query(
      `with connection_row as (
            insert into app.connections (
              id,workspace_id,provider_key,name,auth_type,status,
              current_secret_version_id,created_by
            ) values ($4,$1,'email','Failure notification email',
              'resend_api_key','active',$5,$6)
          ), secret_row as (
            insert into app.connection_secret_versions (
              id,workspace_id,connection_id,kms_key_reference,
              encrypted_data_key,ciphertext,nonce,auth_tag,created_by
            ) values ($5,$1,$4,'kms','key','cipher','AAAAAAAAAAAAAAAA',
              'AAAAAAAAAAAAAAAAAAAAAA',$6)
          ), slack_connection_row as (
            insert into app.connections (
              id,workspace_id,provider_key,name,auth_type,status,
              current_secret_version_id,created_by
            ) values ($8,$1,'slack','Failure notification Slack',
              'slack_bot_token','active',$9,$6)
          ), slack_secret_row as (
            insert into app.connection_secret_versions (
              id,workspace_id,connection_id,kms_key_reference,
              encrypted_data_key,ciphertext,nonce,auth_tag,created_by
            ) values ($9,$1,$8,'kms','slack-key','slack-cipher',
              'BBBBBBBBBBBBBBBB','BBBBBBBBBBBBBBBBBBBBBB',$6)
          ), destination_row as (
            insert into app.failure_notification_destinations
              (id,workspace_id,kind,status,current_config_version,created_by)
            values ($2,$1,'email','enabled',1,$6)
          ), destination_version as (
            insert into app.failure_notification_destination_versions
              (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
            values ($1,$2,1,'email','idempotent_with_key',$7::jsonb,$6)
          ), slack_destination_row as (
            insert into app.failure_notification_destinations
              (id,workspace_id,kind,status,current_config_version,created_by)
            values ($10,$1,'slack','enabled',1,$6)
          ), slack_destination_version as (
            insert into app.failure_notification_destination_versions
              (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
            values ($1,$10,1,'slack','unsafe',$11::jsonb,$6)
          )
          insert into app.workflow_failure_notification_policies
            (workspace_id,workflow_id,destination_id,updated_by)
          values ($1,$3,$2,$6)`,
      [
        workspaceId,
        destinationId,
        workflowId,
        connectionId,
        secretVersionId,
        actorId,
        JSON.stringify({
          connectionId,
          toEmail: 'failure-notification@example.test',
        }),
        slackConnectionId,
        slackSecretVersionId,
        slackDestinationId,
        JSON.stringify({
          connectionId: slackConnectionId,
          channelId: 'C12345',
        }),
      ],
    );
  } finally {
    await fixturePool.end();
  }
  const accepted = await acceptRun();
  const emailIdentity = await terminalizeFailedRun(accepted);
  await apiQuery(
    `update app.workflow_failure_notification_policies set destination_id=$3
          where workspace_id=$1 and workflow_id=$2`,
    [workspaceId, workflowId, slackDestinationId],
  );
  const slackAccepted = await acceptRun();
  const slackIdentity = await terminalizeFailedRun(slackAccepted);
  const intentId = emailIdentity.intentId;
  const initialOutboxEventId = emailIdentity.outboxEventId;
  const initialPayload = {
    workspaceId,
    notificationIntentId: intentId,
    outboxEventId: initialOutboxEventId,
  };
  const slackIntentId = slackIdentity.intentId;
  const slackOutboxEventId = slackIdentity.outboxEventId;
  const slackPayload = {
    workspaceId,
    notificationIntentId: slackIntentId,
    outboxEventId: slackOutboxEventId,
  };
  const initialTruth = await workerQuery<{
    event_count: string;
    revision: number;
    run_status: string;
  }>(
    `select run.status run_status,checkpoint.revision,
                (select count(*)::text from app.run_events event
                  where event.workflow_run_id=run.id) event_count
           from app.workflow_runs run
           join app.run_checkpoints checkpoint on checkpoint.workflow_run_id=run.id
          where run.workspace_id=$1 and run.id=$2`,
    [workspaceId, accepted.runId],
  );

  return {
    secretVersionId,
    slackConnectionId,
    accepted,
    intentId,
    initialOutboxEventId,
    initialPayload,
    slackIntentId,
    slackOutboxEventId,
    slackPayload,
    initialTruth,
  };
}
