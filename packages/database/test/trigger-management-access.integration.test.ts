import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { ScheduleTriggerError } from '../src/triggers/schedule-trigger-errors.js';
import { createScheduleTriggerDatabase } from '../src/triggers/schedule-trigger-database.js';
import {
  scopedConnectionUrl,
  waitForApplicationLock,
} from './support/postgres-lock-coordination.js';
import { createScheduleTriggerTestEnvironment } from './support/schedule-triggers.integration.support.js';

const schedule = createScheduleTriggerTestEnvironment();
const { actorId, ownerQuery, triggerId, workflowId, workspaceId } = schedule;

beforeAll(schedule.initialize);
afterAll(schedule.close);

describe('trigger management authority linearization', () => {
  it('lets an authorized command finish before a waiting suspension and denies later commands', async () => {
    const workerConnectionString = schedule.worker.options.connectionString;
    if (workerConnectionString === undefined)
      throw new Error('worker connection string was not configured');
    const databasePath = new URL(workerConnectionString).pathname;
    const commandApplicationName = `trigger-command-${randomUUID()}`;
    const suspensionApplicationName = `trigger-suspension-${randomUUID()}`;
    const apiUrl = scopedConnectionUrl(
      process.env.DATABASE_API_URL ??
        'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo',
      databasePath,
      commandApplicationName,
    );
    const migrationUrl = scopedConnectionUrl(
      process.env.DATABASE_MIGRATION_URL ??
        'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
      databasePath,
      suspensionApplicationName,
    );
    const adminUrl = scopedConnectionUrl(
      process.env.DATABASE_ADMIN_URL ??
        'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
      databasePath,
    );
    const commands = createScheduleTriggerDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
    );
    const observer = new Pool({ connectionString: adminUrl, max: 2 });
    const workflowBlocker = await observer.connect();
    const suspensionPool = new Pool({ connectionString: migrationUrl, max: 1 });
    const suspensionClient = await suspensionPool.connect();
    const firstKey = `authority-before-suspension-${randomUUID()}`;
    const deniedKey = `authority-after-suspension-${randomUUID()}`;
    let workflowBlockerOpen = false;
    let suspensionTransactionOpen = false;
    let command: ReturnType<typeof commands.setEnabled> | undefined;
    let suspension: Promise<unknown> | undefined;
    try {
      await workflowBlocker.query('begin');
      workflowBlockerOpen = true;
      await workflowBlocker.query(
        'select id from app.workflows where id=$1 for update',
        [workflowId],
      );

      command = commands.setEnabled({
        actorId,
        enabled: false,
        idempotencyKey: firstKey,
        requestHash: createHash('sha256').update(firstKey).digest('hex'),
        triggerId,
        workflowId,
        workspaceId,
      });
      void command.catch(() => undefined);
      await waitForApplicationLock(observer, commandApplicationName);

      await suspensionClient.query('begin');
      suspensionTransactionOpen = true;
      await suspensionClient.query('set local role pertexo_owner');
      await suspensionClient.query(
        "select set_config('app.workspace_id',$1,true)",
        [workspaceId],
      );
      suspension = suspensionClient.query(
        `update app.workspace_memberships set status='suspended'
          where workspace_id=$1 and user_id=$2`,
        [workspaceId, actorId],
      );
      void suspension.catch(() => undefined);
      await waitForApplicationLock(observer, suspensionApplicationName);

      await workflowBlocker.query('commit');
      workflowBlockerOpen = false;
      await expect(command).resolves.toMatchObject({
        replayed: false,
        trigger: { id: triggerId, status: 'disabled' },
      });
      await expect(suspension).resolves.toMatchObject({ rowCount: 1 });
      await suspensionClient.query('commit');
      suspensionTransactionOpen = false;

      await expect(
        commands.setEnabled({
          actorId,
          enabled: true,
          idempotencyKey: deniedKey,
          requestHash: createHash('sha256').update(deniedKey).digest('hex'),
          triggerId,
          workflowId,
          workspaceId,
        }),
      ).rejects.toBeInstanceOf(ScheduleTriggerError);

      await expect(
        ownerQuery<{
          audit_count: number;
          command_count: number;
          membership_status: string;
          schedule_status: string;
          trigger_status: string;
        }>(
          `select membership.status membership_status,
                  schedule.status schedule_status,trigger.status trigger_status,
                  (select count(*)::int from app.audit_events audit
                    where audit.workspace_id=$1 and audit.actor_user_id=$2
                      and audit.target_id=$3
                      and audit.action='schedule_trigger.disabled') audit_count,
                  (select count(*)::int from app.idempotency_records command
                    where command.workspace_id=$1
                      and command.operation='schedule.trigger.setenabled'
                      and command.scope=$2||':'||$3) command_count
             from app.workspace_memberships membership
             join app.trigger_schedules schedule on schedule.trigger_id=$3
             join app.workflow_triggers trigger on trigger.id=schedule.trigger_id
            where membership.workspace_id=$1 and membership.user_id=$2`,
          [workspaceId, actorId, triggerId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            audit_count: 1,
            command_count: 1,
            membership_status: 'suspended',
            schedule_status: 'disabled',
            trigger_status: 'disabled',
          },
        ],
      });
    } finally {
      if (workflowBlockerOpen)
        await workflowBlocker.query('rollback').catch(() => undefined);
      if (suspensionTransactionOpen)
        await suspensionClient.query('rollback').catch(() => undefined);
      await Promise.allSettled(
        [command, suspension].filter(
          (pending): pending is Promise<unknown> => pending !== undefined,
        ),
      );
      workflowBlocker.release();
      suspensionClient.release();
      await Promise.allSettled([
        ownerQuery(
          `update app.workspace_memberships set status='active'
            where workspace_id=$1 and user_id=$2`,
          [workspaceId, actorId],
        ),
        ownerQuery(
          `update app.trigger_schedules set status='enabled',health_status='healthy',
             last_error_code=null where workspace_id=$1 and trigger_id=$2`,
          [workspaceId, triggerId],
        ),
        ownerQuery(
          `update app.workflow_triggers set status='active',health_status='healthy',
             last_error_code=null where workspace_id=$1 and id=$2`,
          [workspaceId, triggerId],
        ),
      ]);
      await Promise.allSettled([
        commands.close(),
        suspensionPool.end(),
        observer.end(),
      ]);
    }
  });
});
