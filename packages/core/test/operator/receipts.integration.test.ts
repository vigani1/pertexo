import { createHash, randomUUID } from 'node:crypto';

import { canonicalJson } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';

import {
  actorRef,
  base,
  maintenance,
  reason,
  schedule,
  workspaceId,
} from './commands.support.js';

describe('a retry from before the pass', () => {
  const sha256 = (text: string) =>
    createHash('sha256').update(text).digest('hex');

  async function seedReceipt(
    commandId: string,
    type: string,
    dryRun: boolean,
    fingerprint: string,
  ) {
    const client = await maintenance.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.operator_commands(
           id,workspace_id,command_type,dry_run,request_fingerprint,status,outcome,result,completed_at
         ) values($1,$2,$3,$4,$5,'completed','stored_outcome','{"stored":true}'::jsonb,clock_timestamp())`,
        [commandId, workspaceId, type, dryRun, fingerprint],
      );
      await client.query('commit');
    } finally {
      client.release();
    }
  }

  const dryRun = true;
  const attemptId = randomUUID();
  const targetRun = randomUUID();
  const targetOutbox = randomUUID();
  const targetWorkflow = randomUUID();
  const targetVersion = randomUUID();
  const evidenceRef = { receipt: 'r-1' };

  // The request material as it stood before the pass, field by field.
  const RECEIPTS = [
    {
      type: 'outbox.redispatch',
      dryRun,
      material: { outboxEventId: targetOutbox },
      send: (input: ReturnType<typeof base>) =>
        schedule.operator.redispatchFailedOutbox({
          ...input,
          dryRun,
          outboxEventId: targetOutbox,
        }),
    },
    {
      type: 'attempt.reconcile',
      dryRun,
      material: { action: 'reclaim', expectedFence: 4, targetId: attemptId },
      send: (input: ReturnType<typeof base>) =>
        schedule.operator.reconcileAttempt({
          ...input,
          dryRun,
          action: 'reclaim',
          attemptId,
          expectedFenceToken: 4,
        }),
    },
    {
      type: 'due-work.resume',
      dryRun,
      material: { targetId: targetRun },
      send: (input: ReturnType<typeof base>) =>
        schedule.operator.resumeDueWork({
          ...input,
          dryRun,
          runId: targetRun,
        }),
    },
    {
      type: 'run.cancel',
      dryRun,
      material: { targetId: targetRun },
      send: (input: ReturnType<typeof base>) =>
        schedule.operator.cancelRun({ ...input, dryRun, runId: targetRun }),
    },
    {
      type: 'unknown-outcome.record-evidence',
      dryRun: false,
      material: {
        evidenceKind: 'provider.receipt',
        evidenceRef,
        targetId: attemptId,
      },
      send: (input: ReturnType<typeof base>) =>
        schedule.operator.recordUnknownOutcomeEvidence({
          ...input,
          attemptId,
          evidenceKind: 'provider.receipt',
          evidenceRef,
        }),
    },
    {
      type: 'trigger.reconcile',
      dryRun,
      material: { workflowId: targetWorkflow },
      send: (input: ReturnType<typeof base>) =>
        schedule.operator.retryTriggerReconciliation({
          ...input,
          dryRun,
          workflowId: targetWorkflow,
        }),
    },
    {
      type: 'run.replay',
      dryRun,
      material: {
        runInput: { pinned: true },
        sourceRunId: targetRun,
        workflowVersionId: targetVersion,
      },
      send: (input: ReturnType<typeof base>) =>
        schedule.operator.replayRun({
          ...input,
          dryRun,
          runInput: { pinned: true },
          sourceRunId: targetRun,
          workflowVersionId: targetVersion,
        }),
    },
  ] as const;

  it.each(RECEIPTS.map((receipt) => [receipt.type, receipt] as const))(
    '%s still matches its stored receipt and gets the stored outcome',
    async (type, receipt) => {
      const input = base();
      const fingerprint = sha256(
        canonicalJson({
          ...receipt.material,
          actorRef,
          commandType: type,
          dryRun: receipt.dryRun,
          reason,
          workspaceId,
        }),
      );
      await seedReceipt(input.commandId, type, receipt.dryRun, fingerprint);

      await expect(receipt.send(input)).resolves.toMatchObject({
        commandId: input.commandId,
        outcome: 'stored_outcome',
        replayed: true,
        status: 'completed',
      });
    },
  );
});
