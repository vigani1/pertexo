import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { appendRunEvent } from '@pertexo/core/testing';
import {
  createWorkspaceDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../../support/better-auth/real-api.support.js';
import { apiBaseUrl } from '../../support/better-auth/api/environment.js';
import { createPreviewBoundary } from '../../node-testing/preview-boundary.fixture.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'HTTP visibility after a lost final run hint',
  () => {
    const api = useBetterAuthRealApi('lost_final_hint');
    it('delivers a durable terminal event on the established stream without another hint or reconnect', async () => {
      const f = await createPreviewBoundary(api);
      await f.save();
      const draft = await api.send('GET', f.draft, { browser: f.browser });
      const published = await api.send(
        'POST',
        `${f.root}/workflows/${f.workflowId}/publish`,
        {
          browser: f.browser,
          headers: {
            'idempotency-key': randomUUID(),
            'if-match': String(draft.headers.etag),
          },
        },
      );
      expect(published.statusCode, published.payload).toBe(200);
      const accepted = await api.send(
        'POST',
        `${f.root}/workflows/${f.workflowId}/runs`,
        {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: {},
        },
      );
      expect(accepted.statusCode, accepted.payload).toBe(202);
      const runId = accepted.json<{ run: { id: string } }>().run.id;
      const url = new URL(apiBaseUrl);
      const adminUrl = api.database().options.connectionString;
      assert(adminUrl !== undefined);
      url.pathname = new URL(adminUrl).pathname;
      const database = createWorkspaceDatabase(
        parseDatabaseConfig({ connectionString: url.toString(), max: 1 }),
      );
      const abort = new AbortController();
      const base = await api.listen();
      const response = await fetch(`${base}${f.root}/runs/${runId}/events`, {
        headers: { cookie: f.browser.cookie },
        signal: abort.signal,
      });
      expect(response.status).toBe(200);
      assert(response.body !== null);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        let initial = '';
        while (!initial.includes('id: 1')) {
          const chunk = await reader.read();
          expect(chunk.done).toBe(false);
          initial += decoder.decode(chunk.value);
        }
        const pending = reader.read();
        await delay(150);
        const sequence = await database.withWorkspace(
          f.workspaceId,
          (transaction) =>
            appendRunEvent(transaction, {
              runId,
              event: { type: 'run.succeeded', payload: {} },
            }),
        );
        const received = (async () => {
          let text = decoder.decode((await pending).value);
          while (!text.includes('event: run.succeeded')) {
            const chunk = await reader.read();
            expect(chunk.done).toBe(false);
            text += decoder.decode(chunk.value);
          }
          return text;
        })();
        const visible = await Promise.race([
          received,
          delay(7_000).then(() => 'visibility deadline'),
        ]);
        expect(visible).toContain(`id: ${String(sequence)}`);
        expect(visible).toContain('event: run.succeeded');
      } finally {
        abort.abort();
        await reader.cancel().catch(() => undefined);
        await database.close();
      }
    }, 15_000);
  },
);
