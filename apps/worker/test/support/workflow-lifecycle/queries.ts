import { JOB_NAME } from '@pertexo/queue';

import type { Pool } from 'pg';

import { ownerRole } from './environment.js';
import {
  lifecycleRunKeys,
  type LifecycleRunKey,
  type LifecycleIds,
  type LifecycleProjection,
  type RunSnapshot,
  type LifecycleOutboxEvent,
} from './contract.js';
import { withTransaction } from './transactions.js';

export function createLifecycleReads(
  context: Readonly<{
    requireOwner: () => Pool;
    requireWorker: () => Pool;
    workspaceId: string;
    ids: LifecycleIds;
  }>,
) {
  const { requireOwner, requireWorker, workspaceId, ids } = context;
  const readProjection = async (): Promise<LifecycleProjection> =>
    withTransaction(
      requireOwner(),
      workspaceId,
      async (client) => {
        const workflow = await client.query<{
          lifecycle_status: string;
          lifecycle_revision: number;
          activation_status: string;
          published_version_id: string | null;
        }>(
          `select lifecycle_status,lifecycle_revision,activation_status,published_version_id
           from app.workflows where id=$1`,
          [ids.workflow],
        );
        const triggers = await client.query<{
          id: string;
          kind: string;
          status: string;
          health_status: string;
          config_fingerprint: string;
        }>(
          `select id,kind,status,health_status,config_fingerprint
           from app.workflow_triggers where workflow_id=$1 order by id`,
          [ids.workflow],
        );
        const endpoints = await client.query<{
          id: string;
          status: string;
        }>(
          `select id,status from app.webhook_trigger_endpoints
           where workspace_id=$1 order by id`,
          [workspaceId],
        );
        const schedules = await client.query<{
          trigger_id: string;
          status: string;
          health_status: string;
          config_fingerprint: string;
        }>(
          `select trigger_id,status,health_status,config_fingerprint
           from app.trigger_schedules where workspace_id=$1 order by trigger_id`,
          [workspaceId],
        );
        const workflowRow = workflow.rows[0];
        if (workflowRow === undefined)
          throw new Error('Workflow projection missing');
        return {
          workflow: {
            lifecycleStatus: workflowRow.lifecycle_status,
            lifecycleRevision: workflowRow.lifecycle_revision,
            activationStatus: workflowRow.activation_status,
            publishedVersionId: workflowRow.published_version_id,
          },
          triggers: triggers.rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            status: row.status,
            healthStatus: row.health_status,
            configFingerprint: row.config_fingerprint,
          })),
          endpoints: endpoints.rows.map((row) => ({
            id: row.id,
            status: row.status,
          })),
          schedules: schedules.rows.map((row) => ({
            triggerId: row.trigger_id,
            status: row.status,
            healthStatus: row.health_status,
            configFingerprint: row.config_fingerprint,
          })),
        };
      },
      ownerRole,
    );

  const readRunSnapshot = async (): Promise<RunSnapshot> =>
    withTransaction(requireWorker(), workspaceId, async (client) => {
      const runIds = lifecycleRunKeys.map((key) => ids.runs[key]);
      const runs = await client.query<{ id: string; value: string }>(
        `select id,row_to_json(run)::text as value
             from app.workflow_runs run
            where workspace_id=$1 and id=any($2::uuid[])
            order by id`,
        [workspaceId, runIds],
      );
      const events = await client.query<{
        workflow_run_id: string;
        value: string;
      }>(
        `select workflow_run_id,row_to_json(event)::text as value
             from app.run_events event
            where workspace_id=$1 and workflow_run_id=any($2::uuid[])
            order by workflow_run_id,sequence`,
        [workspaceId, runIds],
      );
      const checkpoints = await client.query<{
        workflow_run_id: string;
        value: string;
      }>(
        `select workflow_run_id,row_to_json(checkpoint)::text as value
             from app.run_checkpoints checkpoint
            where workspace_id=$1 and workflow_run_id=any($2::uuid[])
            order by workflow_run_id`,
        [workspaceId, runIds],
      );

      const runValues = new Map(
        runs.rows.map((row) => [row.id, row.value] as const),
      );
      const eventValues = new Map<string, string[]>();
      for (const row of events.rows) {
        const values = eventValues.get(row.workflow_run_id) ?? [];
        values.push(row.value);
        eventValues.set(row.workflow_run_id, values);
      }
      const checkpointValues = new Map(
        checkpoints.rows.map(
          (row) => [row.workflow_run_id, row.value] as const,
        ),
      );
      const runAt = (key: LifecycleRunKey): string => {
        const value = runValues.get(ids.runs[key]);
        if (value === undefined)
          throw new Error(`Run ${key} is missing from worker projection`);
        return value;
      };
      const eventsAt = (key: LifecycleRunKey): readonly string[] => {
        const values = eventValues.get(ids.runs[key]);
        if (values === undefined || values.length === 0)
          throw new Error(
            `Run ${key} events are missing from worker projection`,
          );
        return Object.freeze([...values]);
      };
      const checkpointAt = (key: LifecycleRunKey): string => {
        const value = checkpointValues.get(ids.runs[key]);
        if (value === undefined)
          throw new Error(
            `Run ${key} checkpoint is missing from worker projection`,
          );
        return value;
      };
      return Object.freeze({
        runs: Object.freeze({
          queued: runAt('queued'),
          running: runAt('running'),
          waiting: runAt('waiting'),
          succeeded: runAt('succeeded'),
        }),
        events: Object.freeze({
          queued: eventsAt('queued'),
          running: eventsAt('running'),
          waiting: eventsAt('waiting'),
          succeeded: eventsAt('succeeded'),
        }),
        checkpoints: Object.freeze({
          queued: checkpointAt('queued'),
          running: checkpointAt('running'),
          waiting: checkpointAt('waiting'),
          succeeded: checkpointAt('succeeded'),
        }),
      });
    });

  const readOutboxEvent = async (id: string): Promise<LifecycleOutboxEvent> =>
    withTransaction(
      requireOwner(),
      workspaceId,
      async (client) => {
        const result = await client.query<{
          id: string;
          payload: LifecycleOutboxEvent['payload'];
        }>(
          `select id,payload from app.outbox_events where id=$1 and job_name=$2`,
          [id, JOB_NAME.reconcileWorkflowTriggers],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error(`Outbox event ${id} is missing`);
        return row;
      },
      ownerRole,
    );

  return { readProjection, readRunSnapshot, readOutboxEvent };
}
