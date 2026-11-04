import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';
import { createScheduleTriggerScanner } from '../../../src/triggers/schedules/scanner.js';
import { triggerGraph } from '../webhooks/context.js';
import {
  beforeAllFixture1,
  afterAllFixture2,
  actorId,
  workspaceId,
  apiConfig,
  schedules,
  ownerQuery,
  publishTriggerWorkflow,
  publishNextTriggerWorkflowVersion,
  deliverReconciliation,
  workflowTriggerIds,
  checkpointFactory,
  hash,
  authoring,
  appendReconciliationEvent,
} from '../webhooks/fixture.js';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);

async function draft(workflowId: string) {
  const value = await authoring.getDraft(workspaceId, workflowId, actorId);
  if (value === null) throw new Error('Missing draft');
  return {
    value,
    representationTag: workflowDraftRepresentationTag({
      workflowId,
      revision: value.revision,
      graph: value.graphJson,
      compatibilityFingerprint: value.compatibility.fingerprint,
    }),
  };
}
async function publish(workflowId: string) {
  const { representationTag } = await draft(workflowId);
  const result = await authoring.publishWorkflow({
    actorId,
    workspaceId,
    workflowId,
    representationTag,
    idempotencyKey: randomUUID(),
    requestHash: hash(randomUUID()),
  });
  await deliverReconciliation(
    workflowId,
    result.version.id,
    await appendReconciliationEvent(workflowId, result.version.id),
  );
  return result;
}
async function changeGraph(
  workflowId: string,
  graphJson: ReturnType<typeof triggerGraph>,
) {
  const { value, representationTag } = await draft(workflowId);
  await authoring.saveDraft({
    actorId,
    workspaceId,
    workflowId,
    representationTag,
    expectedRevision: value.revision,
    graphJson,
  });
  return publish(workflowId);
}
async function start() {
  const first = await publishTriggerWorkflow(false, {}, 60);
  const workflowId = first.created.workflowId;
  await deliverReconciliation(workflowId, first.published.version.id, {
    eventId: first.eventId,
    payloadChecksum: first.eventChecksum,
  });
  return { workflowId, versionId: first.published.version.id };
}
async function restore(workflowId: string, versionId: string) {
  const { representationTag } = await draft(workflowId);
  await authoring.restoreWorkflowVersion({
    workspaceId,
    actorId,
    workflowId,
    versionId,
    representationTag,
  });
  const result = await publish(workflowId);
  expect(result).toMatchObject({ reused: true, version: { id: versionId } });
}
async function expectFires(workflowId: string) {
  const { scheduleId } = await workflowTriggerIds(workflowId);
  expect(await schedules.list({ workspaceId, workflowId, actorId })).toEqual([
    expect.objectContaining({ id: scheduleId, status: 'active' }),
  ]);
  await ownerQuery(
    "update app.trigger_schedules set anchor_at=date_trunc('milliseconds',clock_timestamp())-interval '61 minutes', next_fire_at=date_trunc('milliseconds',clock_timestamp())-interval '1 minute' where trigger_id=$1",
    [scheduleId],
  );
  const scanner = createScheduleTriggerScanner(apiConfig, apiConfig);
  try {
    await scanner.scanDue({
      leaseOwner: 'restored-publication',
      limit: 50,
      leaseSeconds: 30,
      onTimeWindowSeconds: 300,
      checkpointFactory,
    });
  } finally {
    await scanner.close();
  }
  expect(
    (
      await ownerQuery(
        "select trigger_id from app.trigger_schedule_occurrences where trigger_id=$1 and disposition='accepted'",
        [scheduleId],
      )
    ).rows,
  ).toEqual([{ trigger_id: scheduleId }]);
}

it('hands the serving state to a retained restored version and keeps an unchanged republish firing', async () => {
  const { workflowId, versionId } = await start();
  const next = await publishNextTriggerWorkflowVersion(workflowId, 60);
  await deliverReconciliation(workflowId, next.published.version.id, {
    eventId: next.eventId,
    payloadChecksum: next.eventChecksum,
  });
  await restore(workflowId, versionId);
  await publish(workflowId);
  await expectFires(workflowId);
});

it('uses the enabled restored instance rather than a higher retired version', async () => {
  const { workflowId, versionId } = await start();
  const next = await publishNextTriggerWorkflowVersion(workflowId, 60);
  await deliverReconciliation(workflowId, next.published.version.id, {
    eventId: next.eventId,
    payloadChecksum: next.eventChecksum,
  });
  await restore(workflowId, versionId);
  await schedules.setEnabled({
    workspaceId,
    actorId,
    workflowId,
    triggerId: (await workflowTriggerIds(workflowId)).scheduleId,
    enabled: true,
    idempotencyKey: randomUUID(),
    requestHash: hash(randomUUID()),
  });
  const third = await publishNextTriggerWorkflowVersion(workflowId, 60);
  await deliverReconciliation(workflowId, third.published.version.id, {
    eventId: third.eventId,
    payloadChecksum: third.eventChecksum,
  });
  await expectFires(workflowId);
});

it.each(['removed', 'webhook'] as const)(
  'keeps an enabled step after it was %s and returns',
  async (kind) => {
    const { workflowId } = await start();
    const graph = triggerGraph(60);
    if (kind === 'removed')
      graph.nodes = graph.nodes.filter((node) => node.id !== 'schedule');
    else {
      const node = graph.nodes.find((node) => node.id === 'schedule');
      if (node === undefined) throw new Error('Missing schedule');
      node.definition = { key: 'core.webhook', version: 1 };
      node.config = {};
    }
    await changeGraph(workflowId, graph);
    const returned = triggerGraph(60);
    returned.nodes.forEach((node) => {
      node.position.x = 42;
    });
    await changeGraph(workflowId, returned);
    await expectFires(workflowId);
  },
);
