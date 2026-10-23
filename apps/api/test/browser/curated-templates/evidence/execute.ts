import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { z } from 'zod';
import {
  workflowDraftResponseSchema,
  workflowPublishResponseSchema,
  workflowTemplateOriginProjectionResponseSchema,
  workflowRunStartResponseSchema,
  workflowRunResponseSchema,
} from '@pertexo/contracts';

import {
  curatedContinuationDiagnosticSchema,
  curatedContinuationDiagnosticSql,
} from '../continuation-diagnostic.js';
import {
  type Api,
  terminalStatuses,
  curatedRunDiagnostic,
  curatedWebhookInputCases,
  curatedScheduleInputCase,
} from './contract.js';

/** Explicit manual execution after browser creation-only evidence is verified.
 * Real publication/run admission, outbox, queue, coordinator, executor and stores;
 * not a claim of automatic webhook ingress or timer delivery.
 */
export async function executeCuratedTemplateGraphs(
  api: Api,
  browser: Awaited<ReturnType<Api['signIn']>>,
  workspaceId: string,
  workflowIds: readonly string[],
) {
  const [webhookId, scheduleId, httpId] = workflowIds;
  if (
    webhookId === undefined ||
    scheduleId === undefined ||
    httpId === undefined ||
    workflowIds.length !== 3
  )
    throw new Error('Three reviewed workflow identities required');
  const path = (id: string) => `/v1/workspaces/${workspaceId}/workflows/${id}`;
  const published = new Map<string, string>();
  async function publish(id: string) {
    const draft = await api.send('GET', `${path(id)}/draft`, { browser });
    expect(draft.statusCode).toBe(200);
    const response = await api.send('POST', `${path(id)}/publish`, {
      browser,
      headers: {
        'If-Match': String(draft.headers.etag),
        'Idempotency-Key': randomUUID(),
      },
    });
    expect(response.statusCode).toBe(200);
    published.set(
      id,
      workflowPublishResponseSchema.parse(response.json()).version.id,
    );
  }
  async function run(
    id: string,
    input: unknown,
    terminal: string,
    expectedStatus: 'succeeded' | 'failed' | 'outcome_unknown' = 'succeeded',
  ) {
    const accepted = await api.send('POST', `${path(id)}/runs`, {
      browser,
      headers: { 'Idempotency-Key': randomUUID() },
      // Ordinary manual starts while the independent F02 writer is off. The
      // accepted immutable version is checked below; no concurrent publisher.
      payload: { input },
    });
    expect(accepted.statusCode).toBe(202);
    const runId = workflowRunStartResponseSchema.parse(accepted.json()).run.id;
    let completed: z.infer<typeof workflowRunResponseSchema> | undefined;
    await expect
      .poll(
        async () => {
          const response = await api.send(
            'GET',
            `/v1/workspaces/${workspaceId}/runs/${runId}`,
            { browser },
          );
          expect(response.statusCode).toBe(200);
          completed = workflowRunResponseSchema.parse(response.json());
          return terminalStatuses.has(completed.run.status);
        },
        { timeout: 20000, interval: 100 },
      )
      .toBe(true)
      .catch(async (error: unknown) => {
        if (completed !== undefined)
          process.stderr.write(
            `Owned curated terminal timeout ${JSON.stringify(curatedRunDiagnostic(completed.run.status, completed.nodes))}\n`,
          );
        try {
          const durable = await api
            .database()
            .query(curatedContinuationDiagnosticSql, [workspaceId, runId]);
          process.stderr.write(
            `Owned curated durable continuation ${JSON.stringify(curatedContinuationDiagnosticSchema.parse(durable.rows[0]))}\n`,
          );
        } catch {
          process.stderr.write(
            'Owned curated durable continuation unavailable\n',
          );
        }
        throw error;
      });
    if (completed === undefined)
      throw new Error('Terminal run snapshot missing');
    if (completed.run.status !== expectedStatus)
      process.stderr.write(
        `Owned curated terminal failure ${JSON.stringify(curatedRunDiagnostic(completed.run.status, completed.nodes))}\n`,
      );
    expect(completed.run.status).toBe(expectedStatus);
    const executed = await api
      .database()
      .query<{ node_id: string; status: string }>(
        'select node_id,status from app.node_runs where workspace_id=$1 and workflow_run_id=$2 order by node_id',
        [workspaceId, runId],
      );
    expect(executed.rows).toContainEqual({
      node_id: terminal,
      status: expectedStatus,
    });
    const version = await api
      .database()
      .query<{ workflow_version_id: string }>(
        'select workflow_version_id from app.workflow_runs where workspace_id=$1 and id=$2',
        [workspaceId, runId],
      );
    expect(version.rows).toEqual([{ workflow_version_id: published.get(id) }]);
    return { runId, nodes: executed.rows };
  }
  await publish(webhookId);
  const accepted = await run(
    webhookId,
    curatedWebhookInputCases.accepted,
    'accepted',
  );
  expect(
    accepted.nodes.some(
      (node) => node.node_id === 'rejected' && node.status === 'succeeded',
    ),
  ).toBe(false);
  const rejected = await run(
    webhookId,
    curatedWebhookInputCases.rejected,
    'rejected',
  );
  expect(
    rejected.nodes.some(
      (node) => node.node_id === 'accepted' && node.status === 'succeeded',
    ),
  ).toBe(false);
  const missing = await run(
    webhookId,
    curatedWebhookInputCases.missing,
    'rejected',
  );
  expect(
    missing.nodes.some(
      (node) => node.node_id === 'accepted' && node.status === 'succeeded',
    ),
  ).toBe(false);
  await publish(scheduleId);
  const nonempty = await run(
    scheduleId,
    curatedScheduleInputCase,
    'batch-complete',
  );
  async function bodyCount(runId: string) {
    const result = await api
      .database()
      .query<{ count: number }>(
        "select count(*)::int as count from app.node_runs where workspace_id=$1 and workflow_run_id=$2 and node_id='batch-body-result'",
        [workspaceId, runId],
      );
    return result.rows[0]?.count;
  }
  expect(await bodyCount(nonempty.runId)).toBe(2);
  const originBefore = await api.send(
    'GET',
    `${path(scheduleId)}?include=templateOrigin`,
    { browser },
  );
  expect(originBefore.statusCode).toBe(200);
  const origin = workflowTemplateOriginProjectionResponseSchema.parse(
    originBefore.json(),
  ).templateOrigin;
  const draft = await api.send('GET', `${path(scheduleId)}/draft`, { browser });
  expect(draft.statusCode).toBe(200);
  const graph = workflowDraftResponseSchema.parse(draft.json()).graph;
  const saved = await api.send('PUT', `${path(scheduleId)}/draft`, {
    browser,
    headers: { 'If-Match': String(draft.headers.etag) },
    payload: {
      graph: {
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === 'batch-items'
            ? {
                ...node,
                inputMappings: {
                  ...node.inputMappings,
                  items: { kind: 'literal', value: [] },
                },
              }
            : node,
        ),
      },
    },
  });
  expect(saved.statusCode).toBe(200);
  await publish(scheduleId);
  const empty = await run(
    scheduleId,
    curatedScheduleInputCase,
    'batch-complete',
  );
  expect(await bodyCount(empty.runId)).toBe(0);
  const originAfter = await api.send(
    'GET',
    `${path(scheduleId)}?include=templateOrigin`,
    { browser },
  );
  expect(originAfter.statusCode).toBe(200);
  expect(
    workflowTemplateOriginProjectionResponseSchema.parse(originAfter.json())
      .templateOrigin,
  ).toEqual(origin);
  const boundedDraft = await api.send('GET', `${path(scheduleId)}/draft`, {
    browser,
  });
  expect(boundedDraft.statusCode).toBe(200);
  const boundedGraph = workflowDraftResponseSchema.parse(
    boundedDraft.json(),
  ).graph;
  const outOfBoundsSave = await api.send('PUT', `${path(scheduleId)}/draft`, {
    browser,
    headers: { 'If-Match': String(boundedDraft.headers.etag) },
    payload: {
      graph: {
        ...boundedGraph,
        nodes: boundedGraph.nodes.map((node) =>
          node.id === 'batch-items'
            ? {
                ...node,
                inputMappings: {
                  ...node.inputMappings,
                  items: {
                    kind: 'literal',
                    value: [
                      { value: 'a' },
                      { value: 'b' },
                      { value: 'c' },
                      { value: 'd' },
                    ],
                  },
                },
              }
            : node,
        ),
      },
    },
  });
  expect(outOfBoundsSave.statusCode).toBe(200);
  await publish(scheduleId);
  const outOfBounds = await run(
    scheduleId,
    curatedScheduleInputCase,
    'batch-items',
    'failed',
  );
  expect(await bodyCount(outOfBounds.runId)).toBe(0);
  await publish(httpId);
  const notified = await run(httpId, {}, 'notification-complete');
  expect(notified.nodes).toContainEqual({
    node_id: 'slack-notification',
    status: 'succeeded',
  });
  const skipped = await run(httpId, {}, 'notification-skipped');
  expect(
    skipped.nodes.some(
      (node) =>
        node.node_id === 'slack-notification' && node.status === 'succeeded',
    ),
  ).toBe(false);
  // The template's request is a GET, which reads without side effects: the
  // controlled provider failure retries under the engine policy and then
  // fails definitely. No Slack dispatch may follow.
  const providerFailure = await run(httpId, {}, 'controlled-http', 'failed');
  expect(
    providerFailure.nodes.some(
      (node) =>
        node.node_id === 'slack-notification' && node.status === 'succeeded',
    ),
  ).toBe(false);
  const dispatch = await api
    .database()
    .query<{ kind: string; count: number }>(
      "select split_part(node.provider_dispatch_binding,':',1) as kind,count(*)::int as count from app.node_attempts attempt join app.node_runs node on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id where node.workspace_id=$1 and node.workflow_run_id=any($2::uuid[]) and node.provider_dispatch_binding is not null and attempt.dispatch_marked_at is not null group by kind order by kind",
      [workspaceId, [notified.runId, skipped.runId, providerFailure.runId]],
    );
  // One request each for the two notification runs, three attempts for the
  // failing GET.
  expect(dispatch.rows).toEqual([
    { kind: 'http', count: 5 },
    { kind: 'slack', count: 1 },
  ]);
  return {
    accepted: accepted.runId,
    rejected: rejected.runId,
    missing: missing.runId,
    nonempty: nonempty.runId,
    empty: empty.runId,
    outOfBounds: outOfBounds.runId,
    notified: notified.runId,
    skipped: skipped.runId,
    providerFailure: providerFailure.runId,
  };
}
