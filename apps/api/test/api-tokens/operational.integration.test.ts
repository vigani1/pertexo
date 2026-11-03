import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apiTokenCreateResponseSchema } from '@pertexo/contracts';
import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import { createAutomationApiFixture } from './api/fixture.js';
import { createTokenWorkspace } from './api/portability/setup.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'operational token commands',
  () => {
    const fixture = createAutomationApiFixture();

    it('keeps lifecycle and pause receipts private to their credential', async () => {
      const { api } = fixture;
      const workspace = await createTokenWorkspace(fixture);
      const workflow = `${workspace.base}/workflows/${workspace.workflowId}`;
      async function token() {
        const response = await api.send(
          'POST',
          `${workspace.base}/api-tokens`,
          {
            browser: workspace.browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: {
              name: 'Operations',
              scopes: ['workflow:read', 'workflow:update', 'workflow:publish'],
            },
          },
        );
        expect(response.statusCode).toBe(201);
        const created = apiTokenCreateResponseSchema.parse(response.json());
        if (created.replayed) throw new Error('First token creation replayed');
        return { authorization: `Bearer ${created.secret}` };
      }
      const first = await token();
      const second = await token();
      const key = randomUUID();
      const archive = {
        headers: { ...first, 'idempotency-key': key },
        payload: { expectedLifecycleRevision: 1 },
      };
      const accepted = await api.send('POST', `${workflow}/archive`, archive);
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json()).toMatchObject({
        workflow: { lifecycleStatus: 'archived', lifecycleRevision: 2 },
        replayed: false,
      });
      const replay = await api.send('POST', `${workflow}/archive`, archive);
      expect(replay.statusCode).toBe(202);
      expect(replay.json()).toMatchObject({ replayed: true });
      for (const caller of [
        { headers: { ...second, 'idempotency-key': key } },
        { browser: workspace.browser, headers: { 'idempotency-key': key } },
      ]) {
        const response = await api.send('POST', `${workflow}/archive`, {
          ...caller,
          payload: archive.payload,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
          code: 'workflow.lifecycle_conflict',
        });
      }
      const restored = await api.send('POST', `${workflow}/restore`, {
        headers: { ...first, 'idempotency-key': randomUUID() },
        payload: { expectedLifecycleRevision: 2 },
      });
      expect(restored.statusCode).toBe(202);
      expect(restored.json()).toMatchObject({
        workflow: { lifecycleStatus: 'active', lifecycleRevision: 3 },
      });
      const settings = await api.send('GET', `${workflow}/auto-pause`, {
        headers: first,
      });
      expect(settings.statusCode).toBe(200);
      const snapshot = settings.json<{
        settingsRevision: number;
        pauseRevision: string;
      }>();
      const updateKey = randomUUID();
      const payload = {
        enabled: true,
        thresholdOverride: 7,
        expectedSettingsRevision: snapshot.settingsRevision,
      };
      const updated = await api.send('PUT', `${workflow}/auto-pause`, {
        headers: { ...first, 'idempotency-key': updateKey },
        payload,
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({
        settings: { thresholdOverride: 7 },
        replayed: false,
      });
      const updatedReplay = await api.send('PUT', `${workflow}/auto-pause`, {
        headers: { ...first, 'idempotency-key': updateKey },
        payload,
      });
      expect(updatedReplay.statusCode).toBe(200);
      expect(updatedReplay.json()).toMatchObject({ replayed: true });
      for (const caller of [
        { headers: { ...second, 'idempotency-key': updateKey } },
        {
          browser: workspace.browser,
          headers: { 'idempotency-key': updateKey },
        },
      ]) {
        expect(
          (
            await api.send('PUT', `${workflow}/auto-pause`, {
              ...caller,
              payload,
            })
          ).statusCode,
        ).toBe(409);
      }
      const resumeKey = randomUUID();
      for (const headers of [first, second]) {
        const response = await api.send('POST', `${workflow}/resume`, {
          headers: { ...headers, 'idempotency-key': resumeKey },
          payload: { expectedPauseRevision: snapshot.pauseRevision },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ replayed: false });
      }
      const restricted = await api.send(
        'POST',
        `${workspace.base}/api-tokens`,
        {
          browser: workspace.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { name: 'Reader', scopes: ['workflow:read'] },
        },
      );
      expect(restricted.statusCode).toBe(201);
      const reader = apiTokenCreateResponseSchema.parse(restricted.json());
      if (reader.replayed) throw new Error('First token creation replayed');
      for (const id of [workspace.workflowId, randomUUID()]) {
        const denied = await api.send(
          'POST',
          `${workspace.base}/workflows/${id}/archive`,
          {
            headers: {
              authorization: `Bearer ${reader.secret}`,
              'idempotency-key': randomUUID(),
            },
            payload: { expectedLifecycleRevision: 3 },
          },
        );
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).toMatchObject({
          code: 'auth.token_scope_required',
        });
      }
    });
  },
);
