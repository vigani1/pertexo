import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apiTokenCreateResponseSchema } from '@pertexo/contracts';
import { betterAuthIntegrationEnabled } from '../../support/better-auth/real-api.support.js';
import { createAutomationApiFixture } from '../api/fixture.js';
import { createTokenWorkspace } from '../api/portability/setup.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'table receipts cannot cross credentials',
  () => {
    const fixture = createAutomationApiFixture(),
      { api } = fixture;
    async function setup() {
      const w = await createTokenWorkspace(fixture);
      async function token() {
        const response = await api.send('POST', `${w.base}/api-tokens`, {
          browser: w.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: {
            name: 'Receipt qualification',
            scopes: ['workflow:update', 'workspace:read'],
          },
        });
        expect(response.statusCode, response.payload).toBe(201);
        const created = apiTokenCreateResponseSchema.parse(response.json());
        if (created.replayed) throw new Error('Fresh token replayed');
        return { authorization: `Bearer ${created.secret}` };
      }
      const first = await token(),
        second = await token();
      const made = await api.send('POST', `${w.base}/data-tables`, {
        headers: { ...first, 'idempotency-key': randomUUID() },
        payload: {
          name: 'Receipt rows',
          columns: [{ name: 'value', type: 'text' }],
        },
      });
      expect(made.statusCode, made.payload).toBe(201);
      return {
        ...w,
        first,
        second,
        table: `${w.base}/data-tables/${made.json<{ id: string }>().id}`,
      };
    }
    it('replays imports exactly, refuses changed intent, and lets another credential execute its own command', async () => {
      const f = await setup(),
        key = randomUUID();
      const send = (
        headers: Record<string, string>,
        csv: string,
        browser?: typeof f.browser,
      ) =>
        api.send('POST', `${f.table}/import`, {
          headers: { ...headers, 'idempotency-key': key },
          ...(browser === undefined ? {} : { browser }),
          payload: { csv },
        });
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await send(f.first, 'value\nfirst\n');
        expect(response.statusCode, response.payload).toBe(200);
        expect(response.json()).toEqual({ affected: 1 });
      }
      const changed = await send(f.first, 'value\nchanged\n');
      expect(changed.statusCode, changed.payload).toBe(409);
      const other = await send(f.second, 'value\nsecond\n');
      expect(other.statusCode, other.payload).toBe(200);
      const cookie = await send({}, 'value\nthird\n', f.browser);
      expect(cookie.statusCode, cookie.payload).toBe(200);
      const found = await api.send('POST', `${f.table}/rows/query`, {
        headers: f.first,
        payload: { filters: [], limit: 10, offset: 0 },
      });
      expect(
        found
          .json<{ rows: { values: unknown }[] }>()
          .rows.map((row) => row.values),
      ).toEqual(
        expect.arrayContaining([
          { value: 'first' },
          { value: 'second' },
          { value: 'third' },
        ]),
      );
      expect(found.json<{ rows: unknown[] }>().rows).toHaveLength(3);
    });
    it('replays removal only for the original credential and rechecks current authority', async () => {
      const f = await setup(),
        key = randomUUID(),
        payload = { expectedRevision: 1 };
      const send = (
        headers: Record<string, string>,
        browser?: typeof f.browser,
      ) =>
        api.send('DELETE', f.table, {
          headers: { ...headers, 'idempotency-key': key },
          ...(browser === undefined ? {} : { browser }),
          payload,
        });
      const accepted = await send(f.first);
      expect(accepted.statusCode, accepted.payload).toBe(200);
      expect(accepted.json()).toEqual({ removed: true });
      const replay = await send(f.first);
      expect(replay.statusCode, replay.payload).toBe(200);
      expect(replay.json()).toEqual(accepted.json());
      for (const caller of [() => send(f.second), () => send({}, f.browser)]) {
        const refused = await caller();
        expect(refused.statusCode, refused.payload).toBe(404);
      }
      await api
        .database()
        .query(
          "update app.workspace_memberships set role='viewer',role_revision=role_revision+1 where workspace_id=$1 and user_id=(select id from app.users where email=$2)",
          [f.workspaceId, f.email],
        );
      expect((await send(f.first)).statusCode).toBe(401);
    });
    it('refuses a damaged import receipt without treating its fields as caller errors', async () => {
      const f = await setup(),
        key = randomUUID(),
        payload = { csv: 'value\nfirst\n' };
      const send = () =>
        api.send('POST', `${f.table}/import`, {
          headers: { ...f.first, 'idempotency-key': key },
          payload,
        });
      expect((await send()).statusCode).toBe(200);
      const damaged = await api
        .database()
        .query(
          `update app.idempotency_records set result_ref='{"private-receipt":true}' where workspace_id=$1 and operation like '%import%'`,
          [f.workspaceId],
        );
      expect(damaged.rowCount).toBe(1);
      const refused = await send();
      expect(refused.json()).not.toHaveProperty('errors');
      expect(refused.payload).not.toContain('private-receipt');
      expect(refused.statusCode, refused.payload).toBe(409);
    });
  },
);
