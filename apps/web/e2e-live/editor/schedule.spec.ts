import { expect, type Request } from '@playwright/test';
import {
  nodeDefinitionListResponseSchema,
  scheduleFireTimesResponseSchema,
  scheduleManagementCommandResponseSchema,
  scheduleOccurrenceListResponseSchema,
  scheduleTriggerHealthSchema,
  scheduleTriggerListResponseSchema,
  workflowNodeRunInputResponseSchema,
  workflowNodeRunOutputResponseSchema,
} from '@pertexo/contracts';
import { test } from '../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../support/ordinary-editor-session';
import { authorScheduledNestedGraph } from '../support/authoring/scheduled';
import {
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  waitForRun,
} from '../support/authoring/single-step';

// Test-control receipt only, not a new application wire contract/dependency.
function readRestartReceipt(value: unknown) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('scope' in value) ||
    typeof value.scope !== 'object' ||
    value.scope === null ||
    !('workspaceId' in value.scope) ||
    !('workflowId' in value.scope) ||
    !('workflowVersionId' in value.scope) ||
    !('triggerId' in value) ||
    !('nextFireAt' in value) ||
    !('requestId' in value) ||
    !('beforeObservedAt' in value) ||
    !('afterObservedAt' in value)
  )
    throw new Error('Owned schedule restart receipt is invalid');
  const id = scheduleTriggerHealthSchema.shape.id;
  const timestamp = scheduleTriggerHealthSchema.shape.nextFireAt;
  return {
    scope: {
      workspaceId: id.parse(value.scope.workspaceId),
      workflowId: id.parse(value.scope.workflowId),
      workflowVersionId: id.parse(value.scope.workflowVersionId),
    },
    triggerId: id.parse(value.triggerId),
    nextFireAt: timestamp.parse(value.nextFireAt),
    requestId: id.parse(value.requestId),
    beforeObservedAt: timestamp.parse(value.beforeObservedAt),
    afterObservedAt: timestamp.parse(value.afterObservedAt),
  };
}
const isPost = (request: Request, path: string) =>
  request.method() === 'POST' && new URL(request.url()).pathname === path;

test('real one-minute schedule survives runtime restart and completes bounded nested items', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000); // This case alone waits for the public one-minute minimum.
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined)
    throw new Error('Run through the owned API integration fixture');
  await registerEditorUser(
    page,
    request,
    mailOrigin,
    'Scheduled workflow owner',
  );
  const workspaceId = await createEditorWorkspace(
    page,
    'Scheduled workflow gate',
  );
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Scheduled nested proof',
  );
  const workflowId = workflowPath.split('/').at(-1);
  if (workflowId === undefined) throw new Error('Schedule workflow ID missing');
  // Same ordinarily authenticated owner/workflow as the browser journey.
  const initialSchedules = await page.request.get(
    `${workflowPath}/triggers/schedules`,
  );
  expect(initialSchedules.status()).toBe(200);
  expect(
    scheduleTriggerListResponseSchema.parse(await initialSchedules.json())
      .items,
  ).toHaveLength(0);
  const catalogResponse = await page.request.get('/v1/node-definitions');
  expect(catalogResponse.status()).toBe(200);
  const catalog = nodeDefinitionListResponseSchema.parse(
    await catalogResponse.json(),
  );
  expect(
    catalog.items.find(
      (item) =>
        item.definition.key === 'core.schedule' &&
        item.definition.version === 1,
    ),
  ).toBeDefined();
  const manualStarts: Request[] = [];
  page.on('request', (outgoing) => {
    if (isPost(outgoing, `${workflowPath}/runs`)) manualStarts.push(outgoing);
  });
  const authored = await authorScheduledNestedGraph(page, workflowPath);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Publish v1', exact: true }),
  ).toBeEnabled();
  expect((await readEditorDraft(page, workflowPath)).graph).toEqual(
    authored.graph,
  );
  const publicationPending = page.waitForRequest((outgoing) =>
    isPost(outgoing, `${workflowPath}/publish`),
  );
  const version = await publishSingleStep(page, workflowPath);
  const publication = await publicationPending;
  const publishKey = scheduleTriggerHealthSchema.shape.id.parse(
    publication.headers()['idempotency-key'],
  );
  async function triggers() {
    const response = await page.request.get(
      `${workflowPath}/triggers/schedules`,
    );
    expect(response.status()).toBe(200);
    return scheduleTriggerListResponseSchema.parse(await response.json());
  }
  await expect
    .poll(async () => (await triggers()).items[0]?.status)
    .toBe('active');
  const published = await triggers();
  expect(published.items).toHaveLength(1);
  const trigger = published.items[0];
  if (trigger === undefined) throw new Error('Published schedule missing');
  expect(trigger).toMatchObject({
    workflowVersionId: version.id,
    nodeId: authored.scheduleId,
    healthStatus: 'healthy',
    recurrence: { kind: 'interval', intervalMinutes: 1 },
    misfirePolicy: 'catch_up_once',
    lastFireAt: null,
  });
  const triggerPath = `${workflowPath}/triggers/${trigger.id}/schedule`;
  const nextResponse = await page.request.get(
    `${triggerPath}/next-runs?count=3`,
  );
  expect(nextResponse.status()).toBe(200);
  const next = scheduleFireTimesResponseSchema.parse(await nextResponse.json());
  expect(next.items).toHaveLength(3);
  expect(next.items[0]?.scheduledAt).toBe(trigger.nextFireAt);
  const scope = { workspaceId, workflowId, workflowVersionId: version.id };
  const restartResponse = await request.post(`${mailOrigin}/schedule-restart`, {
    data: scope,
  });
  expect(restartResponse.status()).toBe(200);
  const restarted = readRestartReceipt(await restartResponse.json());
  expect(restarted.scope).toEqual(scope);
  expect(restarted.triggerId).toBe(trigger.id);
  expect(restarted.nextFireAt).toBe(trigger.nextFireAt);
  expect(Date.parse(restarted.beforeObservedAt)).toBeLessThan(
    Date.parse(trigger.nextFireAt),
  );
  expect(Date.parse(restarted.afterObservedAt)).toBeLessThan(
    Date.parse(trigger.nextFireAt),
  );
  expect((await triggers()).items[0]?.nextFireAt).toBe(trigger.nextFireAt);
  async function occurrences() {
    const response = await page.request.get(
      `${triggerPath}/occurrences?limit=10`,
    );
    expect(response.status()).toBe(200);
    return scheduleOccurrenceListResponseSchema.parse(await response.json());
  }
  expect((await occurrences()).items).toHaveLength(0);
  // Real scanner clock, without rescheduling SQL, a manual start or fake timers.
  await expect
    .poll(async () => (await occurrences()).items.length, {
      timeout: 75_000,
      intervals: [500, 1_000],
    })
    .toBe(1);
  const recorded = await occurrences();
  expect(recorded.nextCursor).toBeNull();
  const occurrence = recorded.items[0];
  if (occurrence?.runId === null || occurrence?.runId === undefined)
    throw new Error('Scheduled run not accepted');
  expect(trigger.nextFireAt).toMatch(/\.\d{3}Z$/u);
  expect(occurrence.scheduledAt).toBe(`${trigger.nextFireAt.slice(0, -1)}000Z`);
  expect(occurrence.outcome).toBe('accepted');
  const runId = occurrence.runId;
  const completed = await waitForRun(page, workspaceId, runId, 'succeeded');
  expect(completed.run.workflowVersionId).toBe(version.id);
  expect(completed.nodes).toHaveLength(8);
  const leaves = completed.nodes.filter(
    (node) => node.nodeId === authored.leafId,
  );
  expect(leaves).toHaveLength(4);
  const observedItems: unknown[] = [];
  for (const leaf of leaves) {
    const path = `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${leaf.id}`;
    const input = await page.request.get(`${path}/input`);
    const output = await page.request.get(`${path}/output`);
    expect(input.status()).toBe(200);
    expect(output.status()).toBe(200);
    const inputPayload = workflowNodeRunInputResponseSchema.parse(
      await input.json(),
    );
    const outputPayload = workflowNodeRunOutputResponseSchema.parse(
      await output.json(),
    );
    expect(outputPayload.output).toEqual(inputPayload.input);
    observedItems.push(inputPayload.input);
  }
  expect(observedItems).toEqual(
    expect.arrayContaining(
      ['north-0', 'north-1', 'south-0', 'south-1'].map((item, index) =>
        expect.objectContaining({
          kind: 'inline',
          value: { item, ordinal: index % 2 },
        }),
      ),
    ),
  );
  await page.goto(`/w/${workspaceId}/runs/${runId}`);
  await expect(
    page.getByRole('link', { name: 'v1', exact: true }),
  ).toHaveAttribute(
    'href',
    `/w/${workspaceId}/workflows/${workflowId}/versions`,
  );
  await page.goto(`/w/${workspaceId}/workflows/${workflowId}/triggers`);
  const card = page.getByRole('article', {
    name: 'Schedule: Minute schedule',
    exact: true,
  });
  const disablePending = page.waitForRequest((outgoing) =>
    isPost(outgoing, `${triggerPath}/disable`),
  );
  await card.getByRole('switch', { name: 'Schedule on', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Turn off this schedule?', exact: true })
    .getByRole('button', { name: 'Turn off', exact: true })
    .click();
  const disable = await disablePending;
  const disableKey = scheduleTriggerHealthSchema.shape.id.parse(
    disable.headers()['idempotency-key'],
  );
  expect(disable.postDataJSON()).toEqual({});
  const disabledResponse = await disable.response();
  if (disabledResponse === null)
    throw new Error('Explicit schedule disable response missing');
  expect(disabledResponse.status()).toBe(200);
  expect(
    scheduleManagementCommandResponseSchema.parse(
      await disabledResponse.json(),
    ),
  ).toMatchObject({
    trigger: { id: trigger.id, status: 'disabled' },
    replayed: false,
  });
  await expect(
    card.getByRole('switch', { name: 'Schedule on', exact: true }),
  ).not.toBeChecked();
  expect((await occurrences()).items).toHaveLength(1);
  expect(manualStarts).toHaveLength(0);
  const evidence = await request.post(`${mailOrigin}/evidence/schedule`, {
    data: {
      ...scope,
      triggerId: trigger.id,
      runId,
      scheduleId: authored.scheduleId,
      outerId: authored.outerId,
      innerId: authored.innerId,
      leafId: authored.leafId,
      scheduledAt: occurrence.scheduledAt,
      firstDueAt: trigger.nextFireAt,
      occurrenceId: occurrence.id,
      publishKey,
      disableKey,
    },
  });
  expect(evidence.status()).toBe(204);
});
