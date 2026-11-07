import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAutomationApiFixture } from '../api/api-token-api.fixture.js';
import { createTokenWorkspace } from '../api/portability/setup.js';
import { betterAuthIntegrationEnabled } from '../../support/better-auth/real-api.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'table outcomes and actionable conflicts through HTTP',
  () => {
    const fixture = createAutomationApiFixture(),
      { api } = fixture;
    async function table() {
      const w = await createTokenWorkspace(fixture),
        base = `${w.base}/data-tables`;
      const made = await api.send('POST', base, {
        browser: w.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Orders',
          columns: [
            { name: 'key', type: 'text', required: true },
            { name: 'amount', type: 'number' },
          ],
          keyColumn: 'key',
        },
      });
      expect(made.statusCode, made.payload).toBe(201);
      const id = made.json<{ id: string }>().id;
      return { ...w, id, table: `${base}/${id}`, tables: base };
    }
    it('writes and edits the selected row at its reviewed revision, preserving unrelated rows', async () => {
      const f = await table();
      for (const key of ['first', 'second']) {
        const inserted = await api.send('POST', `${f.table}/rows`, {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: {
            command: {
              operation: 'insert',
              table: 'Orders',
              values: { key, amount: 1 },
            },
          },
        });
        expect(inserted.statusCode, inserted.payload).toBe(200);
      }
      const queried = await api.send('POST', `${f.table}/rows/query`, {
        browser: f.browser,
        payload: { filters: [], limit: 10, offset: 0 },
      });
      const rows = queried.json<{
        rows: {
          id: string;
          revision: number;
          values: { key: string; amount: number };
        }[];
      }>().rows;
      const row = rows.find((value) => value.values.key === 'first');
      if (row === undefined) throw new Error('Inserted row missing');
      const edit = {
        command: {
          operation: 'update',
          table: 'Orders',
          query: {},
          values: { amount: 7 },
        },
        rowId: row.id,
        expectedRevision: row.revision,
      };
      const accepted = await api.send('POST', `${f.table}/rows`, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: edit,
      });
      expect(accepted.statusCode, accepted.payload).toBe(200);
      expect(accepted.json()).toMatchObject({ affected: 1 });
      const after = await api.send('POST', `${f.table}/rows/query`, {
        browser: f.browser,
        payload: { filters: [], limit: 10, offset: 0 },
      });
      expect(
        after
          .json<{ rows: { values: unknown }[] }>()
          .rows.map((value) => value.values),
      ).toEqual(
        expect.arrayContaining([
          { key: 'first', amount: 7 },
          { key: 'second', amount: 1 },
        ]),
      );
      const stale = await api.send('POST', `${f.table}/rows`, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: edit,
      });
      expect(stale.statusCode, stale.payload).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'data_table.conflict' });
      for (const payload of [
        { command: edit.command, rowId: row.id },
        { command: edit.command, expectedRevision: row.revision },
      ]) {
        const invalid = await api.send('POST', `${f.table}/rows`, {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload,
        });
        expect(invalid.statusCode, invalid.payload).toBe(400);
        expect(invalid.json()).toHaveProperty('errors');
      }
    });
    it('distinguishes a used unique key from a full row quota and preserves the accepted row', async () => {
      const f = await table();
      const limits = await api.send('PUT', `${f.tables}/limits`, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          tableLimit: 2,
          columnLimit: 5,
          rowLimit: 2,
          byteLimit: 65536,
        },
      });
      expect(limits.statusCode, limits.payload).toBe(200);
      const write = (key: string) =>
        api.send('POST', `${f.table}/rows`, {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: {
            command: {
              operation: 'insert',
              table: 'Orders',
              values: { key, amount: 1 },
            },
          },
        });
      expect((await write('used')).statusCode).toBe(200);
      const duplicate = await write('used');
      expect(duplicate.statusCode, duplicate.payload).toBe(409);
      expect(duplicate.json()).toMatchObject({
        code: 'data_table.key_conflict',
      });
      expect((await write('second')).statusCode).toBe(200);
      const full = await write('third');
      expect(full.statusCode, full.payload).toBe(409);
      expect(full.json()).toMatchObject({ code: 'data_table.quota_exceeded' });
      const rows = await api.send('POST', `${f.table}/rows/query`, {
        browser: f.browser,
        payload: { filters: [], limit: 10, offset: 0 },
      });
      expect(rows.json<{ rows: unknown[] }>().rows).toHaveLength(2);
    });
  },
);
