import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apiTokenCreateResponseSchema } from '@pertexo/contracts';
import { createWorkflowTriggerReconciliationStore } from '@pertexo/core/triggers';
import { createEditorWebhookRuntime } from '../browser/editor/webhook-runtime.js';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import { createTokenWorkspace } from './api/portability/setup.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'published trigger token operations',
  () => {
    let reconciliation: ReturnType<
      typeof createWorkflowTriggerReconciliationStore
    >;
    const api = useBetterAuthRealApi('token_triggers', {
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
    const fixture = { api, listen: () => api.listen() };

    it('reads published trigger metadata and isolates schedule and endpoint commands', async () => {
      const workspace = await createTokenWorkspace(fixture);
      async function credential() {
        const response = await api.send(
          'POST',
          `${workspace.base}/api-tokens`,
          {
            browser: workspace.browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: {
              name: 'Trigger operator',
              scopes: ['workflow:read', 'workflow:update'],
            },
          },
        );
        expect(response.statusCode).toBe(201);
        const token = apiTokenCreateResponseSchema.parse(response.json());
        if (token.replayed) throw new Error('First token creation replayed');
        return { authorization: `Bearer ${token.secret}` };
      }
      const first = await credential();
      const second = await credential();
      for (const kind of ['webhook', 'schedule'] as const) {
        const created = await api.send('POST', `${workspace.base}/workflows`, {
          browser: workspace.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { name: `Token ${kind}` },
        });
        expect(created.statusCode).toBe(201);
        const workflowId = created.json<{ workflow: { id: string } }>().workflow
          .id;
        const path = `${workspace.base}/workflows/${workflowId}`;
        const nodeId = randomUUID();
        const config =
          kind === 'schedule'
            ? { kind: 'interval', intervalMinutes: 5, misfirePolicy: 'skip' }
            : {};
        const saved = await api.send('PUT', `${path}/draft`, {
          browser: workspace.browser,
          headers: { 'if-match': String(created.headers.etag) },
          payload: {
            graph: {
              nodes: [
                {
                  id: nodeId,
                  definition: { key: `core.${kind}`, version: 1 },
                  configVersion: 1,
                  config,
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
          browser: workspace.browser,
          headers: {
            'if-match': String(saved.headers.etag),
            'idempotency-key': randomUUID(),
          },
          payload: {},
        });
        expect(published.statusCode, published.payload).toBe(200);
        const versionId = published.json<{ version: { id: string } }>().version
          .id;
        const event = await api
          .database()
          .query<{ id: string }>(
            "select id from app.outbox_events where aggregate_id=$1 and job_name='reconcile-workflow-triggers' order by created_at desc limit 1",
            [workflowId],
          );
        const outboxEventId = event.rows[0]?.id;
        if (outboxEventId === undefined)
          throw new Error('Publish omitted reconciliation event');
        const triggers = await reconciliation.reconcile({
          workspaceId: workspace.workspaceId,
          workflowId,
          publishedVersionId: versionId,
          outboxEventId,
        });
        const trigger = triggers.find((entry) => entry.kind === kind);
        if (trigger === undefined) throw new Error('Published trigger missing');
        const base = `${path}/triggers`;
        const listed = await api.send(
          'GET',
          kind === 'webhook' ? base : `${base}/schedules`,
          { headers: first },
        );
        expect(listed.statusCode, listed.payload).toBe(200);
        expect(listed.json()).toMatchObject({
          items: [expect.objectContaining({ id: trigger.id })],
        });
        const endpoint = `${base}/${trigger.id}/${kind}`;
        const commandPath =
          kind === 'webhook' ? `${endpoint}/provision` : `${endpoint}/disable`;
        const key = randomUUID();
        const command = {
          headers: { ...first, 'idempotency-key': key },
          payload: {},
        };
        const accepted = await api.send('POST', commandPath, command);
        expect(accepted.statusCode, accepted.payload).toBe(200);
        expect(accepted.json()).toMatchObject({ replayed: false });
        if (kind === 'webhook')
          expect(accepted.json()).toHaveProperty('endpointKey');
        const replay = await api.send('POST', commandPath, command);
        expect(replay.statusCode).toBe(200);
        expect(replay.json()).toMatchObject({ replayed: true });
        expect(replay.json()).not.toHaveProperty('endpointKey');
        expect(replay.json()).not.toHaveProperty('signingSecret');
        const other = await api.send('POST', commandPath, {
          headers: { ...second, 'idempotency-key': key },
          payload: {},
        });
        if (kind === 'webhook') {
          expect(other.statusCode).toBe(409);
          expect(other.json()).toMatchObject({ code: 'workspace.conflict' });
          const deliveries = await api.send('GET', `${endpoint}/deliveries`, {
            headers: first,
          });
          expect(deliveries.statusCode).toBe(200);
          const rotation = await api.send(
            'POST',
            `${endpoint}/rotate-endpoint`,
            command,
          );
          expect(rotation.statusCode).toBe(403);
          expect(rotation.json()).toMatchObject({
            code: 'auth.token_not_supported',
          });
        } else {
          expect(other.statusCode).toBe(200);
          expect(other.json()).toMatchObject({ replayed: false });
          const enabled = await api.send('POST', `${endpoint}/enable`, {
            headers: { ...first, 'idempotency-key': randomUUID() },
            payload: {},
          });
          expect(enabled.statusCode).toBe(200);
          for (const resource of ['occurrences', 'next-runs'])
            expect(
              (
                await api.send('GET', `${endpoint}/${resource}`, {
                  headers: first,
                })
              ).statusCode,
            ).toBe(200);
          const preview = await api.send('POST', `${base}/schedules/preview`, {
            headers: first,
            payload: {
              config: {
                kind: 'interval',
                intervalMinutes: 5,
                misfirePolicy: 'skip',
              },
            },
          });
          expect(preview.statusCode, preview.payload).toBe(200);
        }
      }
    });
  },
);
