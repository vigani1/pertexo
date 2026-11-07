import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import { createPreviewBoundary } from './preview-boundary.fixture.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'workspace variables in step checks',
  () => {
    const api = useBetterAuthRealApi('preview_variables');
    it('checks configured and missing mappings against current variables and captures a later revision on acceptance', async () => {
      const f = await createPreviewBoundary(api);
      const put = (expectedRevision: number, values: object) =>
        api.send('PUT', `${f.root}/variables`, {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { expectedRevision, values },
        });
      expect((await put(0, { GREETING: 'hello' })).statusCode).toBe(200);
      const revision = await f.save({
        greeting: { kind: 'workspace_variable', name: 'GREETING' },
        expression: {
          kind: 'expression',
          language: 'jsonata',
          expression: '$vars.GREETING',
        },
      });
      const check = () =>
        api.send('POST', `${f.draft}/nodes/set/test`, {
          browser: f.browser,
          payload: {
            mode: 'validate',
            expectedRevision: revision,
            sampleInput: {},
          },
        });
      const configured = await check();
      expect(configured.statusCode, configured.payload).toBe(200);
      expect(configured.json()).toMatchObject({ valid: true, issues: [] });
      expect((await put(1, {})).statusCode).toBe(200);
      expect((await check()).json()).toMatchObject({ valid: false });
      expect((await put(2, { GREETING: 'changed' })).statusCode).toBe(200);
      const accepted = await api.send('POST', `${f.draft}/nodes/set/test`, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          mode: 'test_execute',
          expectedRevision: revision,
          input: { kind: 'manual', value: {} },
          acknowledgeSideEffects: true,
        },
      });
      expect(accepted.statusCode, accepted.payload).toBe(202);
      const id = accepted.json<{ preview: { id: string } }>().preview.id;
      const stored = await api
        .database()
        .query(
          'select variable_set_revision from app.preview_runs where id=$1',
          [id],
        );
      expect(stored.rows).toEqual([{ variable_set_revision: 3 }]);
    });
  },
);
