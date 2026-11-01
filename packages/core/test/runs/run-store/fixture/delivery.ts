import { randomUUID } from 'node:crypto';

import { canonicalOutboxPayloadChecksum } from '@pertexo/database/testing';

import type {
  TestCommitInput as CommitInput,
  TestRunStore,
} from '../../../support/run-advance-store.js';

import { rawStore, testDeliveries } from './base.js';
import { workerBaseUrl } from './context.js';
import { asRuntime } from './queries.js';

type TestCommitInput = Omit<CommitInput, 'delivery'> &
  Readonly<{ delivery?: CommitInput['delivery'] }>;

export function testDelivery(
  workspaceId: string,
  runId: string,
  expectedRevision: unknown,
): Promise<CommitInput['delivery']> {
  const key = `${workspaceId}:${runId}:${String(expectedRevision)}`;
  const existing = testDeliveries.get(key);
  if (existing !== undefined) return existing;
  const created = (async (): Promise<CommitInput['delivery']> => {
    const outboxEventId = randomUUID();
    const payload = { workspaceId, outboxEventId, runId };
    const payloadChecksum = canonicalOutboxPayloadChecksum(payload);
    await asRuntime(workerBaseUrl, workspaceId, (client) =>
      client.query(
        `insert into app.outbox_events (
           id,workspace_id,job_name,aggregate_type,
           aggregate_id,payload,payload_checksum
         ) values ($1,$2,'advance-workflow-run','workflow-run',$3,$4::jsonb,$5)`,
        [
          outboxEventId,
          workspaceId,
          runId,
          JSON.stringify(payload),
          payloadChecksum,
        ],
      ),
    );
    return Object.freeze({ outboxEventId, payloadChecksum });
  })();
  testDeliveries.set(key, created);
  return created;
}

// Commits that omit a delivery get a matching outbox delivery created here.
export const ownedDeliveryStore = Object.freeze({
  close: () => rawStore.close(),
  loadAdvanceState: (input: Parameters<TestRunStore['loadAdvanceState']>[0]) =>
    rawStore.loadAdvanceState(input),
  acknowledgeAdvanceDelivery: (
    input: Parameters<TestRunStore['acknowledgeAdvanceDelivery']>[0],
  ) => rawStore.acknowledgeAdvanceDelivery(input),
  commitAdvancePlan: async (input: TestCommitInput) =>
    rawStore.commitAdvancePlan({
      ...input,
      delivery:
        input.delivery ??
        (await testDelivery(
          input.workspaceId,
          input.runId,
          typeof input.plan === 'object' &&
            input.plan !== null &&
            'expectedRevision' in input.plan
            ? input.plan.expectedRevision
            : undefined,
        )),
    }),
});
