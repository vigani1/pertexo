import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'damaged stored table definitions',
  () => {
    const api = useBetterAuthRealApi('stored_tables');
    it('explains stored damage and keeps healthy table reads and exports working', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/workspaces');
      const browser = await api.signIn(email);
      const workspace = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'Idempotency-Key': randomUUID() },
        payload: {
          name: 'Stored tables',
          slug: `stored-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(workspace.statusCode, workspace.payload).toBe(201);
      const path = `/v1/workspaces/${workspace.json<{ id: string }>().id}/data-tables`;
      const create = async (name: string) => {
        const response = await api.send('POST', path, {
          browser,
          headers: { 'Idempotency-Key': randomUUID() },
          payload: {
            name,
            columns: [{ name: 'note', type: 'text', required: true }],
          },
        });
        expect(response.statusCode, response.payload).toBe(201);
        return response.json<{ id: string }>().id;
      };
      const damaged = await create('Damaged');
      const healthy = await create('Healthy');
      const inserted = await api.send('POST', `${path}/${healthy}/rows`, {
        browser,
        headers: { 'Idempotency-Key': randomUUID() },
        payload: {
          command: {
            operation: 'insert',
            table: 'Healthy',
            values: { note: 'retained' },
          },
        },
      });
      expect(inserted.statusCode, inserted.payload).toBe(200);

      await api
        .database()
        .query(
          "update app.workspace_data_tables set columns_json='[null]'::jsonb where id=$1",
          [damaged],
        );
      const collection = await api.send('GET', path, { browser });
      expect(collection.statusCode, collection.payload).toBe(200);
      expect(
        collection
          .json<{ tables: { id: string }[] }>()
          .tables.map((table) => table.id),
      ).toEqual([healthy]);
      expect(
        collection.json<{ unavailableTables: unknown[] }>().unavailableTables,
      ).toEqual([
        {
          id: damaged,
          name: 'Damaged',
          reason: 'data_table.stored_definition_invalid',
        },
      ]);
      expect(collection.payload).not.toContain('TypeError');
      for (const response of [
        await api.send('POST', `${path}/${damaged}/rows/query`, {
          browser,
          payload: { filters: [], limit: 1, offset: 0 },
        }),
        await api.send('POST', `${path}/${damaged}/export`, {
          browser,
          payload: { filters: [] },
        }),
      ]) {
        expect(response.statusCode, response.payload).toBe(500);
        const problem = response.json<{ code: string; detail: string }>();
        expect(problem.code).toBe('data_table.stored_definition_invalid');
        expect(problem.detail).toContain('stored table definition is damaged');
        expect(response.payload).not.toContain('TypeError');
      }
      const read = await api.send('POST', `${path}/${healthy}/rows/query`, {
        browser,
        payload: { filters: [], limit: 1, offset: 0 },
      });
      expect(read.statusCode, read.payload).toBe(200);
      expect(
        read
          .json<{ rows: { values: { note: string } }[] }>()
          .rows.map((row) => row.values.note),
      ).toEqual(['retained']);
      const exported = await api.send('POST', `${path}/${healthy}/export`, {
        browser,
        payload: { filters: [] },
      });
      expect(exported.statusCode, exported.payload).toBe(200);
      expect(exported.payload).toContain('note');
      expect(exported.payload).toContain('retained');
    });
  },
);
