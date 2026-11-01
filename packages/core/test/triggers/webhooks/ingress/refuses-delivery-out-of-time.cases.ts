import { webhookRunInput } from '@pertexo/nodes-core';

import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { createEventCoordinationPreparation } from '../../../../src/triggers/coordination/prepare.js';
import { WebhookIntakeBusyError } from '../../../../src/triggers/webhooks/errors.js';
import { acceptVerifiedWebhookDelivery } from '../../../../src/triggers/webhooks/runtime/accept.repository.js';
import { createWorkspaceTurns } from '../../../../src/triggers/webhooks/runtime/workspace-turns.js';

import {
  apiConfig,
  workspaceId,
  hash,
  post,
  owner,
  ownerQuery,
  checkpointFactory,
  createWebhookScenario,
} from '../fixture.js';
import { holdAdmissionRow } from './hold-admission-row.js';

export function registerRefusesDeliveryOutOfTime(): void {
  it('refuses a delivery that waited too long, starts nothing for it and accepts its retry exactly once', async () => {
    const { verification } = await createWebhookScenario();
    const pool = new Pool({ connectionString: apiConfig.connectionString });
    const eventPreparation = createEventCoordinationPreparation();
    const accept = (
      turns: ReturnType<typeof createWorkspaceTurns>,
      key: string,
    ) =>
      acceptVerifiedWebhookDelivery(
        pool,
        { eventPreparation, turns },
        {
          verification,
          verifiedSecretVersionId: verification.currentSecret.id,
          requestFingerprint: hash('refused-payload'),
          idempotencyKeyHash: hash(key),
          runInput: webhookRunInput(verification.runInputMode, post({})),
          bodyBytes: 2,
          checkpointFactory,
        },
      );
    const runs = async () =>
      (
        await ownerQuery<{ count: number }>(
          'select count(*)::int count from app.workflow_runs where workflow_id=$1',
          [verification.workflowId],
        )
      ).rows[0]?.count;
    const replayRows = async (key: string) =>
      (
        await ownerQuery<{ count: number }>(
          'select count(*)::int count from app.webhook_trigger_replay_records where dedupe_key_hash=$1',
          [hash(key)],
        )
      ).rows[0]?.count;

    const turns = createWorkspaceTurns({ atOnce: 1, maxWaitMillis: 100 });
    try {
      const held = await holdAdmissionRow(owner, workspaceId);
      const first = accept(turns, 'first-in-line');
      let refusal: unknown;
      try {
        await expect.poll(() => held.blocked(), { timeout: 10_000 }).toBe(1);
        await accept(turns, 'refused-in-line');
      } catch (error) {
        refusal = error;
      } finally {
        await held.release();
      }
      expect(refusal).toBeInstanceOf(WebhookIntakeBusyError);
      await first;
      expect(await runs()).toBe(1);
      expect(await replayRows('refused-in-line')).toBe(0);

      const retried = await accept(turns, 'refused-in-line');
      const again = await accept(turns, 'refused-in-line');
      expect(again).toMatchObject({
        replayed: true,
        runId: 'runId' in retried ? retried.runId : 'no run',
      });
      expect(await runs()).toBe(2);
    } finally {
      await eventPreparation.close();
      await pool.end();
    }
  }, 30_000);
}
