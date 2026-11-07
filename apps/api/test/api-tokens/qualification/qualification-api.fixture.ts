import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  apiTokenCreateResponseSchema,
  type ApiTokenScope,
} from '@pertexo/contracts';
import { createWorkflowTriggerReconciliationStore } from '@pertexo/core/triggers';
import { createEditorWebhookRuntime } from '../../browser/editor/webhook-runtime.js';
import { useBetterAuthRealApi } from '../../support/better-auth/real-api.support.js';
import { createTokenWorkspace } from '../api/portability/setup.js';

export function useQualificationApi() {
  let reconciliation: ReturnType<
    typeof createWorkflowTriggerReconciliationStore
  >;
  const api = useBetterAuthRealApi('token_qualification', {
    automationTokens: true,
    schedules: true,
    webhookRuntime: (config) => {
      reconciliation = createWorkflowTriggerReconciliationStore(
        config.database,
      );
      return createEditorWebhookRuntime(config.database, randomBytes(32));
    },
    beforeClose: () => reconciliation.close(),
  });
  async function setup() {
    const w = await createTokenWorkspace({ api, listen: () => api.listen() });
    const credentials = new Map<string, Record<string, string>>();
    async function credential(scopes: readonly ApiTokenScope[]) {
      const key = scopes.toSorted().join(',');
      const existing = credentials.get(key);
      if (existing !== undefined) return existing;
      const made = await api.send('POST', `${w.base}/api-tokens`, {
        browser: w.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: `Qualification ${key}`, scopes },
      });
      expect(made.statusCode, made.payload).toBe(201);
      const created = apiTokenCreateResponseSchema.parse(made.json());
      if (created.replayed) throw new Error('Fresh token replayed');
      const headers = { authorization: `Bearer ${created.secret}` };
      credentials.set(key, headers);
      return headers;
    }
    async function trigger(kind: 'webhook' | 'schedule') {
      const created = await api.send('POST', `${w.base}/workflows`, {
        browser: w.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: `Qualified ${kind}` },
      });
      expect(created.statusCode, created.payload).toBe(201);
      const id = created.json<{ workflow: { id: string } }>().workflow.id,
        path = `${w.base}/workflows/${id}`;
      const saved = await api.send('PUT', `${path}/draft`, {
        browser: w.browser,
        headers: { 'if-match': String(created.headers.etag) },
        payload: {
          graph: {
            nodes: [
              {
                id: randomUUID(),
                definition: { key: `core.${kind}`, version: 1 },
                configVersion: 1,
                config:
                  kind === 'schedule'
                    ? {
                        kind: 'interval',
                        intervalMinutes: 5,
                        misfirePolicy: 'skip',
                      }
                    : {},
                inputMappings: {},
                connectionRefs: {},
                position: { x: 0, y: 0 },
              },
            ],
            edges: [],
            settings: {},
          },
        },
      });
      expect(saved.statusCode, saved.payload).toBe(200);
      const published = await api.send('POST', `${path}/publish`, {
        browser: w.browser,
        headers: {
          'idempotency-key': randomUUID(),
          'if-match': String(saved.headers.etag),
        },
        payload: {},
      });
      expect(published.statusCode, published.payload).toBe(200);
      const version = published.json<{ version: { id: string } }>().version.id;
      const {
        rows: [event],
      } = await api
        .database()
        .query<{ id: string }>(
          "select id from app.outbox_events where aggregate_id=$1 and job_name='reconcile-workflow-triggers' order by created_at desc limit 1",
          [id],
        );
      if (event === undefined) throw new Error('Reconciliation event missing');
      const triggers = await reconciliation.reconcile({
        workspaceId: w.workspaceId,
        workflowId: id,
        publishedVersionId: version,
        outboxEventId: event.id,
      });
      const selected = triggers.find((value) => value.kind === kind);
      if (selected === undefined) throw new Error('Trigger missing');
      return {
        workflow: path,
        base: `${path}/triggers`,
        endpoint: `${path}/triggers/${selected.id}/${kind}`,
        id: selected.id,
      };
    }
    const webhook = await trigger('webhook'),
      schedule = await trigger('schedule');
    const table = await api.send('POST', `${w.base}/data-tables`, {
      browser: w.browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        name: 'Qualified rows',
        columns: [{ name: 'value', type: 'text' }],
      },
    });
    expect(table.statusCode, table.payload).toBe(201);
    const tableId = table.json<{ id: string }>().id;
    const tag = await api.send('POST', `${w.base}/workflow-tags`, {
      browser: w.browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: { key: 'qualified' },
    });
    expect(tag.statusCode, tag.payload).toBe(201);
    const variables = await api.send('GET', `${w.base}/variables`, {
      browser: w.browser,
    });
    expect(variables.statusCode, variables.payload).toBe(200);
    return {
      ...w,
      variableRevision: variables.json<{ revision: number }>().revision,
      credential,
      webhook,
      schedule,
      tableId,
      tagId: tag.json<{ tag: { id: string } }>().tag.id,
    };
  }
  return { api, setup };
}
export type World = Awaited<
  ReturnType<ReturnType<typeof useQualificationApi>['setup']>
>;
