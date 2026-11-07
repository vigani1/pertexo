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
    it('does not use or disclose variables from an inaccessible workspace', async () => {
      const own = await createPreviewBoundary(api);
      const foreign = await createPreviewBoundary(api);
      const foreignName = 'FOREIGN_ONLY_ISOLATION_MARKER';
      const foreignValue = 'foreign-value-never-disclosed-4400';
      const stored = await api.send('PUT', `${foreign.root}/variables`, {
        browser: foreign.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          expectedRevision: 0,
          values: { GREETING: foreignValue, [foreignName]: foreignValue },
        },
      });
      expect(stored.statusCode, stored.payload).toBe(200);
      const mappings = {
        greeting: { kind: 'workspace_variable', name: 'GREETING' },
      };
      const revision = await own.save(mappings);
      const foreignRevision = await foreign.save(mappings);
      const check = (draft: string, expectedRevision: number) =>
        api.send('POST', `${draft}/nodes/set/test`, {
          browser: own.browser,
          payload: { mode: 'validate', expectedRevision, sampleInput: {} },
        });
      const local = await check(own.draft, revision);
      expect(local.statusCode, local.payload).toBe(200);
      expect(local.json()).toMatchObject({ valid: false });
      expect(local.payload).toContain('GREETING');
      const denied = await check(foreign.draft, foreignRevision);
      expect(denied.statusCode, denied.payload).toBe(404);
      expect(denied.json()).toMatchObject({ code: 'resource.not_found' });
      const absent = await check(
        `${own.root}/workflows/${randomUUID()}/draft`,
        revision,
      );
      expect(absent.statusCode, absent.payload).toBe(404);
      expect(absent.json()).toMatchObject({ code: 'resource.not_found' });
      for (const response of [local, denied, absent]) {
        expect(response.payload).not.toContain(foreignName);
        expect(response.payload).not.toContain(foreignValue);
      }
    });
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
