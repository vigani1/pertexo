import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  webhookTriggerListResponseSchema,
  webhookManagementCommandResponseSchema,
  webhookIngressResponseSchema,
  webhookDeliveryListResponseSchema,
} from '@pertexo/contracts/schemas/webhooks';
import {
  scheduleTriggerListResponseSchema,
  scheduleOccurrenceListResponseSchema,
  scheduleManagementCommandResponseSchema,
} from '@pertexo/contracts/schemas/schedules';
import {
  workflowDraftResponseSchema,
  workflowPublishResponseSchema,
  workflowTemplateOriginProjectionResponseSchema,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { workflowRunResponseSchema } from '@pertexo/contracts/schemas/workflow-runs';
import type { useBetterAuthRealApi } from './better-auth-real-api.integration.support.js';
import { sendBoundedWebhook } from '../webhooks/bounded-webhook-client.js';
import { curatedWebhookInputCases } from './curated-template-worker-evidence.js';

type Api = ReturnType<typeof useBetterAuthRealApi>;

export function curatedAutomaticScheduleVariation(
  graph: ReturnType<typeof workflowDraftResponseSchema.parse>['graph'],
) {
  if (
    graph.nodes.filter(
      (node) =>
        node.id === 'schedule-start' &&
        node.definition.key === 'core.schedule' &&
        node.definition.version === 1,
    ).length !== 1 ||
    graph.nodes.filter((node) => node.id === 'batch-items').length !== 1
  )
    throw new Error('Reviewed schedule graph required');
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === 'schedule-start'
        ? {
            ...node,
            config: {
              kind: 'interval',
              intervalMinutes: 1,
              misfirePolicy: 'skip',
            },
          }
        : node.id === 'batch-items'
          ? {
              ...node,
              inputMappings: {
                ...node.inputMappings,
                items: { kind: 'literal', value: ['first', 'second'] },
              },
            }
          : node,
    ),
  };
}

export function curatedScheduleTimestamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value))
    throw new Error('Owned schedule UTC timestamp required');
  const [whole, fraction = ''] = value.slice(0, -1).split('.');
  if (whole === undefined)
    throw new Error('Owned schedule UTC timestamp required');
  return `${whole}.${fraction.padEnd(6, '0')}Z`;
}

/** Disposable fixture only. Real ingress and database-clock scanner delivery;
 * the one-minute schedule is an independently edited variation, not asset v1.
 */
export async function executeCuratedTemplateTriggers(
  api: Api,
  browser: Awaited<ReturnType<Api['signIn']>>,
  workspaceId: string,
  workflowIds: readonly string[],
  apiOrigin: string,
) {
  const origin = new URL(apiOrigin);
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== ''
  )
    throw new Error('Owned loopback API required');
  const [webhookId, scheduleId] = workflowIds;
  if (
    workflowIds.length !== 3 ||
    webhookId === undefined ||
    scheduleId === undefined
  )
    throw new Error('Three reviewed workflow identities required');
  const path = (id: string) => `/v1/workspaces/${workspaceId}/workflows/${id}`;
  async function get(url: string): Promise<unknown> {
    const response = await api.send('GET', url, { browser });
    expect(response.statusCode).toBe(200);
    return response.json();
  }
  async function command(url: string): Promise<unknown> {
    const response = await api.send('POST', url, {
      browser,
      headers: { 'Idempotency-Key': randomUUID() },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }
  async function terminal(
    runId: string,
    versionId: string,
    triggerType: string,
    succeeded: string,
    skipped?: string,
  ) {
    let observedStatus = 'queued';
    await expect
      .poll(
        async () => {
          const snapshot = workflowRunResponseSchema.parse(
            await get(`/v1/workspaces/${workspaceId}/runs/${runId}`),
          );
          observedStatus = snapshot.run.status;
          return [
            'succeeded',
            'failed',
            'canceled',
            'timed_out',
            'outcome_unknown',
          ].includes(observedStatus);
        },
        { timeout: 20000, interval: 100 },
      )
      .toBe(true);
    expect(observedStatus).toBe('succeeded');
    const identity = await api
      .database()
      .query(
        'select workflow_version_id,trigger_type from app.workflow_runs where workspace_id=$1 and id=$2',
        [workspaceId, runId],
      );
    expect(identity.rows).toEqual([
      { workflow_version_id: versionId, trigger_type: triggerType },
    ]);
    const nodes = await api
      .database()
      .query<{ node_id: string; status: string }>(
        'select node_id,status from app.node_runs where workspace_id=$1 and workflow_run_id=$2',
        [workspaceId, runId],
      );
    expect(nodes.rows).toContainEqual({
      node_id: succeeded,
      status: 'succeeded',
    });
    if (skipped !== undefined)
      expect(nodes.rows).toContainEqual({
        node_id: skipped,
        status: 'skipped',
      });
    return nodes.rows;
  }

  let webhook:
    | ReturnType<typeof webhookTriggerListResponseSchema.parse>['items'][number]
    | undefined;
  await expect
    .poll(
      async () => {
        webhook = webhookTriggerListResponseSchema
          .parse(await get(`${path(webhookId)}/triggers`))
          .items.find((item) => item.nodeId === 'webhook-start');
        return webhook !== undefined;
      },
      { timeout: 10000, interval: 100 },
    )
    .toBe(true);
  if (webhook === undefined)
    throw new Error('Owned webhook reconciliation missing');
  const provision = webhookManagementCommandResponseSchema.parse(
    await command(
      `${path(webhookId)}/triggers/${webhook.id}/webhook/provision`,
    ),
  );
  // Never pass the one-time material to assertion diagnostics or evidence output.
  if (
    provision.replayed ||
    provision.endpointKey === undefined ||
    provision.signingSecret === undefined
  )
    throw new Error('Owned webhook provisioning unavailable');
  const webhookRuns: Record<string, string> = {};
  for (const [name, input] of Object.entries(curatedWebhookInputCases)) {
    const rawBody = Buffer.from(JSON.stringify(input));
    try {
      let response;
      try {
        response = await sendBoundedWebhook({
          origin: apiOrigin,
          endpointKey: provision.endpointKey,
          secret: provision.signingSecret,
          idempotencyKey: randomUUID(),
          rawBody,
        });
      } catch {
        throw new Error('Owned webhook ingress transport failed');
      }
      expect(response.status).toBe(202);
      const accepted = webhookIngressResponseSchema.parse(response.json);
      expect(accepted.replayed).toBe(false);
      await terminal(
        accepted.runId,
        webhook.workflowVersionId,
        'webhook',
        name === 'accepted' ? 'accepted' : 'rejected',
        name === 'accepted' ? 'rejected' : 'accepted',
      );
      const deliveries = webhookDeliveryListResponseSchema.parse(
        await get(
          `${path(webhookId)}/triggers/${webhook.id}/webhook/deliveries`,
        ),
      );
      expect(
        deliveries.items.find((item) => item.runId === accepted.runId),
      ).toMatchObject({
        outcome: 'accepted',
        signatureCheck: 'verified',
        replayCheck: 'new',
        httpStatus: 202,
      });
      webhookRuns[name] = accepted.runId;
    } finally {
      rawBody.fill(0);
    }
  }

  const originalOrigin = workflowTemplateOriginProjectionResponseSchema.parse(
    await get(`${path(scheduleId)}?include=templateOrigin`),
  ).templateOrigin;
  const draftResponse = await api.send('GET', `${path(scheduleId)}/draft`, {
    browser,
  });
  expect(draftResponse.statusCode).toBe(200);
  const graph = workflowDraftResponseSchema.parse(draftResponse.json()).graph;
  const variation = curatedAutomaticScheduleVariation(graph);
  const save = await api.send('PUT', `${path(scheduleId)}/draft`, {
    browser,
    headers: { 'If-Match': String(draftResponse.headers.etag) },
    payload: { graph: variation },
  });
  expect(save.statusCode).toBe(200);
  const publishedDraft = await api.send('GET', `${path(scheduleId)}/draft`, {
    browser,
  });
  expect(publishedDraft.statusCode).toBe(200);
  const publication = await api.send('POST', `${path(scheduleId)}/publish`, {
    browser,
    headers: {
      'If-Match': String(publishedDraft.headers.etag),
      'Idempotency-Key': randomUUID(),
    },
  });
  expect(publication.statusCode).toBe(200);
  const versionId = workflowPublishResponseSchema.parse(publication.json())
    .version.id;
  expect(
    workflowTemplateOriginProjectionResponseSchema.parse(
      await get(`${path(scheduleId)}?include=templateOrigin`),
    ).templateOrigin,
  ).toEqual(originalOrigin);
  let schedule:
    | ReturnType<
        typeof scheduleTriggerListResponseSchema.parse
      >['items'][number]
    | undefined;
  await expect
    .poll(
      async () => {
        schedule = scheduleTriggerListResponseSchema
          .parse(await get(`${path(scheduleId)}/triggers/schedules`))
          .items.find(
            (item) =>
              item.workflowVersionId === versionId &&
              item.nodeId === 'schedule-start',
          );
        return schedule?.status;
      },
      { timeout: 10000, interval: 100 },
    )
    .toBe('active');
  if (schedule === undefined)
    throw new Error('Owned schedule reconciliation missing');
  expect(schedule.recurrence).toEqual({ kind: 'interval', intervalMinutes: 1 });
  const triggerPath = `${path(scheduleId)}/triggers/${schedule.id}/schedule`;
  let occurrence:
    | ReturnType<
        typeof scheduleOccurrenceListResponseSchema.parse
      >['items'][number]
    | undefined;
  await expect
    .poll(
      async () => {
        occurrence = scheduleOccurrenceListResponseSchema
          .parse(await get(`${triggerPath}/occurrences`))
          .items.find((item) => item.outcome === 'accepted');
        return occurrence?.runId !== undefined && occurrence.runId !== null;
      },
      { timeout: 75000, interval: 500 },
    )
    .toBe(true);
  if (occurrence?.runId === null || occurrence?.runId === undefined)
    throw new Error('Owned automatic schedule delivery missing');
  expect(curatedScheduleTimestamp(occurrence.scheduledAt)).toBe(
    curatedScheduleTimestamp(schedule.nextFireAt),
  );
  const disabled = scheduleManagementCommandResponseSchema.parse(
    await command(`${triggerPath}/disable`),
  );
  expect(disabled.trigger.status).toBe('disabled');
  const leases = await api
    .database()
    .query(
      'select lease_owner,lease_token,lease_expires_at from app.trigger_schedules where workspace_id=$1 and trigger_id=$2',
      [workspaceId, schedule.id],
    );
  expect(leases.rows).toEqual([
    { lease_owner: null, lease_token: null, lease_expires_at: null },
  ]);
  const nodes = await terminal(
    occurrence.runId,
    versionId,
    'schedule',
    'batch-complete',
  );
  expect(
    nodes.filter((node) => node.node_id === 'batch-body-result'),
  ).toHaveLength(2);
  return {
    webhookRuns,
    scheduleRunId: occurrence.runId,
    scheduleVersionId: versionId,
    clock: 'actual-database-clock',
    intervalMinutes: 1,
  };
}
