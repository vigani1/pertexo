import { describe, expect, it } from 'vitest';

import {
  cutoffAt,
  operator,
  owner,
  randomUUID,
  retention,
  workspaceId,
} from './support/retention.integration.support.js';

describe('retention operator reruns', () => {
  it('accepts an operator wake while maintenance retains batch authority', async () => {
    const batchId = randomUUID();
    await retention.startDryRun({
      batchId,
      cutoffAt,
      idempotencyKey: `operator-rerun-${batchId}`,
      reason: 'operator rerun target',
      requestedBy: 'retention-integration',
      workspaceId,
    });
    const dryRunCommandId = randomUUID();
    const dryRunCommand = {
      actorRef: 'integration-operator',
      commandId: dryRunCommandId,
      dryRun: true,
      reason: 'inspect stalled retention batch',
      targetId: batchId,
      targetType: 'retention_batch' as const,
      workspaceId,
    };
    const dryRun = await operator.requestMaintenanceRerun(dryRunCommand);
    expect(dryRun).toMatchObject({
      outcome: 'would_request',
      replayed: false,
      status: 'completed',
    });
    expect(await operator.requestMaintenanceRerun(dryRunCommand)).toEqual({
      ...dryRun,
      replayed: true,
    });
    await expect(
      operator.requestMaintenanceRerun({
        ...dryRunCommand,
        reason: 'conflicting reason',
      }),
    ).rejects.toThrow('conflicts');
    const commandId = randomUUID();
    const command = {
      actorRef: 'integration-operator',
      commandId,
      dryRun: false,
      reason: 'wake stalled retention batch',
      targetId: batchId,
      targetType: 'retention_batch' as const,
      workspaceId,
    };
    const requested = await operator.requestMaintenanceRerun(command);
    expect(requested).toMatchObject({
      outcome: 'rerun_requested',
      replayed: false,
      status: 'pending',
    });
    expect(await operator.requestMaintenanceRerun(command)).toEqual({
      ...requested,
      replayed: true,
    });
    await expect(retention.processOperatorRerun()).resolves.toMatchObject({
      commandId,
      outcome: 'rerun_accepted',
      targetId: batchId,
      targetType: 'retention_batch',
      workspaceId,
    });
    await expect(retention.processNext()).resolves.toMatchObject({
      batchId,
      status: 'completed',
    });
    await expect(
      operator.getCommand({
        actorRef: 'integration-operator',
        commandId,
        reason: 'verify maintenance wake',
        workspaceId,
      }),
    ).resolves.toMatchObject({
      outcome: 'rerun_accepted',
      status: 'completed',
    });
  });

  it('routes purge reruns through the same maintenance-only wake', async () => {
    const purgeJobId = randomUUID();
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query(
        `insert into app.workspace_purge_jobs(
           id,workspace_id,command_id,actor_ref,reason,occurred_at
         ) values($1,$2,$3,'maintenance:test','purge rerun target',clock_timestamp())`,
        [purgeJobId, workspaceId, randomUUID()],
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
    const commandId = randomUUID();
    await expect(
      operator.requestMaintenanceRerun({
        actorRef: 'integration-operator',
        commandId,
        dryRun: false,
        reason: 'wake stalled purge job',
        targetId: purgeJobId,
        targetType: 'workspace_purge_job',
        workspaceId,
      }),
    ).resolves.toMatchObject({ status: 'pending' });
    await expect(retention.processOperatorRerun()).resolves.toMatchObject({
      commandId,
      outcome: 'rerun_accepted',
      targetId: purgeJobId,
      targetType: 'workspace_purge_job',
    });
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query(
        "select set_config('app.workspace_purge_transition','on',true)",
      );
      await owner.query('delete from app.workspace_purge_jobs where id=$1', [
        purgeJobId,
      ]);
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
  });
});
