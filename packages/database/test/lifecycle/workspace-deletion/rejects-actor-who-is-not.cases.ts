import { expect, it } from 'vitest';

import { IdempotencyRequestConflictError } from '../../../src/runs/commands/acceptance/errors.js';
import { WorkspaceLifecycleConflictError } from '../../../src/tenant-access/errors.js';

import {
  workspaceId,
  ownerUserId,
  otherUserId,
  connectionId,
  queuedRunId,
  runningRunId,
  scheduleTriggerId,
  workflowId,
  change,
  asOwner,
} from './fixture.js';

export function registerRejectsActorWhoIsNot(): void {
  it('rejects an actor who is not an owner', async () => {
    await expect(
      change({ commandType: 'deletion_requested', actorUserId: otherUserId }),
    ).rejects.toMatchObject({ reason: 'actor_inactive' });
  });

  it('takes effect at once and stops the workspace work', async () => {
    const idempotencyKeyHash = 'a'.repeat(64);
    const operation = await change({
      commandType: 'deletion_requested',
      idempotencyKeyHash,
    });
    expect(operation).toMatchObject({
      workspaceId,
      commandType: 'deletion_requested',
    });
    const receipt = await asOwner(
      `select occurred_at, occurred_at = date_trunc('milliseconds', occurred_at) canonical
       from app.workspace_lifecycle_operations where id=$1`,
      [operation.id],
    );
    expect(receipt.rows).toEqual([
      { occurred_at: operation.submittedAt, canonical: true },
    ]);

    const state = await asOwner(
      `select status, deletion_requested_by, deletion_reason,
         purge_after - deletion_requested_at = interval '30 days' thirty_days
       from app.workspaces where id=$1`,
      [workspaceId],
    );
    expect(state.rows[0]).toEqual({
      status: 'pending_deletion',
      deletion_requested_by: ownerUserId,
      deletion_reason: 'Closing the workspace',
      thirty_days: true,
    });
    const effects = await asOwner(
      `select
        (select status from app.connections where id=$2) connection_status,
        (select count(*) from app.workflow_runs
          where id = any($3::uuid[]) and cancel_requested_at is not null) cancel_requested,
        (select count(*) from app.outbox_events where workspace_id=$1
          and job_name='advance-workflow-run') advances,
        (select status from app.trigger_schedules where trigger_id=$4) schedule_status,
        (select lease_token is null from app.trigger_schedules where trigger_id=$4) lease_cleared,
        (select bool_and(status='disabled') from app.workflow_triggers
          where workspace_id=$1) triggers_disabled,
        (select activation_status from app.workflows where id=$5) workflow_status,
        (select count(*)=0 from app.auth_sessions
          where user_id=$6) sessions_revoked,
        (select count(*) from app.audit_events where workspace_id=$1
          and action='workspace.deletion_requested') audit`,
      [
        workspaceId,
        connectionId,
        [queuedRunId, runningRunId],
        scheduleTriggerId,
        workflowId,
        ownerUserId,
      ],
    );
    expect(effects.rows[0]).toEqual({
      connection_status: 'reauthorization_required',
      cancel_requested: '2',
      advances: '2',
      schedule_status: 'disabled',
      lease_cleared: true,
      triggers_disabled: true,
      workflow_status: 'inactive',
      sessions_revoked: true,
      audit: '1',
    });

    // A retried request returns its first receipt; a different one under the
    // same key conflicts.
    await expect(
      change({ commandType: 'deletion_requested', idempotencyKeyHash }),
    ).resolves.toEqual(operation);
    await expect(
      change({
        commandType: 'deletion_requested',
        idempotencyKeyHash,
        reason: 'Another reason',
      }),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
    await expect(
      change({ commandType: 'deletion_requested' }),
    ).rejects.toBeInstanceOf(WorkspaceLifecycleConflictError);
  });

  it('restores during the recovery period and not after it', async () => {
    await change({ commandType: 'deletion_restored' });
    const restored = await asOwner(
      'select status, purge_after, deletion_reason from app.workspaces where id=$1',
      [workspaceId],
    );
    expect(restored.rows[0]).toEqual({
      status: 'active',
      purge_after: null,
      deletion_reason: null,
    });

    await change({ commandType: 'deletion_requested' });
    await asOwner(
      `update app.workspaces
       set deletion_requested_at = clock_timestamp() - interval '31 days',
           purge_after = clock_timestamp() - interval '1 second'
       where id=$1`,
      [workspaceId],
    );
    await expect(
      change({ commandType: 'deletion_restored' }),
    ).rejects.toMatchObject({ reason: 'invalid_state' });
  });
}
