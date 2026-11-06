import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  jobIdForOutboxEvent,
  JOB_NAME,
  QUEUE_NAME,
} from '@pertexo/queue/server';
import { createCoordinatorRuntime } from '../../../src/runs/coordinator.runtime.js';
import { coordinatorFixture as f } from '../../support/coordinator/consumer.js';
import { acceptRun } from '../../support/coordinator/runs.js';

const destinationId = randomUUID(),
  connectionId = randomUUID(),
  secretId = randomUUID();

describe.runIf(f.enabled)(
  'Emergency settlement after corrupt checkpoint deliveries',
  () => {
    beforeAll(async () => {
      await f.setup();
      const admin = new Pool({
        connectionString: f.databaseUrl(f.adminUrl),
        max: 1,
      });
      try {
        await admin.query(
          `with connection_row as (
        insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by)
        values($1,$4,'email','Emergency notification','resend_api_key','active',$2,$5)
      ), secret_row as (
        insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
        values($2,$4,$1,'kms','key','cipher','AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA',$5)
      ), destination_row as (
        insert into app.failure_notification_destinations(id,workspace_id,kind,status,current_config_version,created_by)
        values($3,$4,'email','enabled',1,$5)
      ), destination_version as (
        insert into app.failure_notification_destination_versions(workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
        values($4,$3,1,'email','idempotent_with_key',$6::jsonb,$5)
      ) insert into app.workflow_failure_notification_policies(workspace_id,workflow_id,destination_id,updated_by) values($4,$7,$3,$5)`,
          [
            connectionId,
            secretId,
            destinationId,
            f.workspaceId,
            f.actorId,
            JSON.stringify({ connectionId, toEmail: 'emergency@example.test' }),
            f.workflowId,
          ],
        );
      } finally {
        await admin.end();
      }
    }, 60_000);
    afterAll(f.restoreServicesAndClose);

    it.each(['nextEventSequence', 'deadlineExpired', 'missing', 'capacity'])(
      'ends a run with damaged %s after bounded real worker retries',
      async (field) => {
        const accepted = await acceptRun();
        if (field === 'capacity')
          await f.ownerQuery(
            `insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload) select $1,$2,n,'run.cancel_requested','{}'::jsonb from generate_series(2,10002) n`,
            [f.workspaceId, accepted.runId],
          );
        else if (field === 'missing')
          await f.ownerQuery(
            'delete from app.run_checkpoints where workflow_run_id=$1',
            [accepted.runId],
          );
        else
          await f.ownerQuery(
            "update app.run_checkpoints set scheduler_state=jsonb_set(scheduler_state,array[$2],to_jsonb('broken'::text)) where workflow_run_id=$1",
            [accepted.runId, field],
          );
        const runtime = await createCoordinatorRuntime({
          database: parseDatabaseConfig({
            connectionString: f.databaseUrl(f.workerUrl),
            max: 4,
          }),
          maintenanceDatabase: parseDatabaseConfig({
            connectionString: f.databaseUrl(f.dispatcherUrl),
            max: 2,
          }),
          maximumAdmissions: 1,
          redisUrl: f.redisUrl,
        });
        const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
          connection: f.redisConnection(),
        });
        let scenarioError: unknown;
        try {
          await runtime.consumer.waitUntilReady(5_000);
          // Exercise all four worker deliveries without the production outage backoff.
          const job = await queue.add(
            JOB_NAME.advanceWorkflowRun,
            {
              workspaceId: f.workspaceId,
              runId: accepted.runId,
              outboxEventId: accepted.outboxEventId,
            },
            {
              jobId: jobIdForOutboxEvent(accepted.outboxEventId),
              attempts: 4,
              backoff: { type: 'fixed', delay: 10 },
            },
          );
          await f.waitFor(
            () => job.getState(),
            (state) => state === 'failed',
            35_000,
          );
          const rows = await f.workerQuery<{
            status: string;
            completed_at: Date;
            error_summary: string;
          }>(
            'select status,completed_at,error_summary from app.workflow_runs where id=$1',
            [accepted.runId],
          );
          expect(rows).toEqual([
            {
              status: 'failed',
              completed_at: expect.any(Date) as unknown,
              error_summary:
                field === 'missing'
                  ? 'execution.checkpoint_missing'
                  : 'execution.run_state_invalid',
            },
          ]);
          expect(
            await f.workerQuery(
              'select completed_at from app.inbox_receipts where message_id=$1',
              [accepted.outboxEventId],
            ),
          ).toEqual([{ completed_at: expect.any(Date) as unknown }]);
          expect(
            await f.workerQuery(
              'select status from app.run_failure_notification_intents where workflow_run_id=$1',
              [accepted.runId],
            ),
          ).toEqual([{ status: 'pending' }]);
          expect(
            await f.workerQuery(
              'select active_runs,queued_runs from app.workspace_execution_admission_counters where workspace_id=$1',
              [f.workspaceId],
            ),
          ).toEqual([{ active_runs: 0, queued_runs: 0 }]);
          expect(
            await f.workerQuery(
              'select id from app.node_attempts where node_run_id in (select id from app.node_runs where workflow_run_id=$1)',
              [accepted.runId],
            ),
          ).toEqual([]);
        } catch (error: unknown) {
          scenarioError = error;
        }
        const results = await Promise.allSettled([
          runtime.close(),
          queue.close(),
        ]);
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason as unknown] : [],
        );
        if (scenarioError !== undefined) failures.unshift(scenarioError);
        if (failures.length > 0)
          throw new AggregateError(
            failures,
            'Corrupt checkpoint scenario or shutdown failed',
          );
      },
      45_000,
    );
  },
);
