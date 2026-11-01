import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { WorkflowAutoPauseSettingsRevisionConflictError } from '../../../../src/testing.js';

import { enforceRetention } from '../../../support/retention.js';

import {
  maintenanceUrl,
  admin,
  controls,
  seed,
  pause,
  failures,
  auditCount,
  pausePeriodCount,
} from './fixture.js';

export function registerRollsBackPauseStreakAudit(): void {
  it('rolls back pause, streak, audit and receipt together when the audit insert fails', async () => {
    const scope = await seed();
    await pause(scope);
    const command = {
      ...scope,
      expectedPauseRevision: '2',
      idempotencyKey: randomUUID(),
    };
    await admin.query(`alter table app.audit_events add constraint test_pause_audit_failure check
      (workspace_id<> '${scope.workspaceId}'::uuid or action<> 'workflow.triggers_resumed')`);
    try {
      await expect(controls().resumeWorkflow(command)).rejects.toThrow(
        /test_pause_audit_failure/u,
      );
      expect((await controls().readWorkflowSettings(scope)).pauseState).toBe(
        'paused',
      );
      expect(await failures(scope)).toBe(3);
      expect(await auditCount(scope, 'workflow.triggers_resumed')).toBe(0);
      expect(await pausePeriodCount(scope)).toBe(0);
    } finally {
      await admin.query(
        'alter table app.audit_events drop constraint test_pause_audit_failure',
      );
    }
    const accepted = await controls().resumeWorkflow(command);
    expect(accepted.replayed).toBe(false);
    expect(accepted.settings.pauseState).toBe('none');
    expect(await failures(scope)).toBe(0);
    expect(await pausePeriodCount(scope)).toBe(1);
  });

  it('removes completed expired control receipts through retention', async () => {
    const scope = await seed();
    const command = {
      ...scope,
      enabled: false,
      thresholdOverride: null,
      expectedSettingsRevision: 1,
      idempotencyKey: randomUUID(),
    };
    await controls().updateWorkflowSettings(command);
    await admin.query(
      "update app.idempotency_records set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and operation='workflow.autopause.settings'",
      [scope.workspaceId],
    );
    const removed = await enforceRetention(maintenanceUrl);
    expect(removed.idempotency_records).toBeGreaterThanOrEqual(1);
    expect(
      (
        await admin.query(
          "select 1 from app.idempotency_records where workspace_id=$1 and operation='workflow.autopause.settings'",
          [scope.workspaceId],
        )
      ).rows,
    ).toHaveLength(0);
    // An expired, reaped key is a new command, and must satisfy current CAS.
    await expect(
      controls().updateWorkflowSettings(command),
    ).rejects.toBeInstanceOf(WorkflowAutoPauseSettingsRevisionConflictError);
  });
}
