import { webhookRunInput } from '@pertexo/nodes-core';

import { setTimeout as delay } from 'node:timers/promises';

import { expect, it } from 'vitest';

import {
  workspaceId,
  hash,
  post,
  webhook,
  owner,
  ownerQuery,
  checkpointFactory,
  createWebhookScenario,
} from '../fixture.js';
import { holdAdmissionRow } from './hold-admission-row.js';

export function registerKeepsOtherWorkServedDuringBurst(): void {
  it('still serves other work while a burst waits on its workspace, then accepts the whole burst', async () => {
    const { verification, resources } = await createWebhookScenario();
    const held = await holdAdmissionRow(owner, workspaceId);
    const burst = Array.from({ length: 20 }, (_, at) =>
      webhook.acceptVerifiedDelivery({
        verification,
        verifiedSecretVersionId: verification.currentSecret.id,
        requestFingerprint: hash('burst-payload'),
        idempotencyKeyHash: hash(`burst-${String(at)}`),
        runInput: webhookRunInput(verification.runInputMode, post({})),
        bodyBytes: 2,
        checkpointFactory,
      }),
    );
    const settled = Promise.allSettled(burst);
    try {
      await expect
        .poll(() => held.blocked(), { timeout: 10_000 })
        .toBeGreaterThan(0);
      // The stuck row must not cost anyone else a connection.
      const servedInTime = await Promise.race([
        webhook
          .resolveVerification(resources.endpointKeyHash)
          .then((reference) => reference !== null),
        delay(3_000).then(() => false),
      ]);
      expect(servedInTime).toBe(true);
    } finally {
      await held.release();
    }
    const outcomes = await settled;
    expect(outcomes.filter(({ status }) => status === 'rejected')).toEqual([]);
    const { rows } = await ownerQuery<{ runs: number }>(
      'select count(*)::int runs from app.workflow_runs where workflow_id=$1',
      [verification.workflowId],
    );
    expect(rows).toEqual([{ runs: burst.length }]);
  }, 30_000);
}
