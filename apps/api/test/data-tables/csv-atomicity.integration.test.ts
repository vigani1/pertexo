import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import { createPreviewBoundary } from '../node-testing/preview-boundary.fixture.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'CSV import atomicity on the real route',
  () => {
    const api = useBetterAuthRealApi('csv_atomicity');
    it('identifies a bad later record and column without importing an earlier valid row', async () => {
      const f = await createPreviewBoundary(api);
      const table = await api.send('POST', `${f.root}/data-tables`, {
        browser: f.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Orders',
          columns: [{ name: 'amount', type: 'number', required: true }],
        },
      });
      expect(table.statusCode, table.payload).toBe(201);
      const id = table.json<{ id: string }>().id;
      const response = await api.send(
        'POST',
        `${f.root}/data-tables/${id}/import`,
        {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { csv: 'amount\n12\nwrong' },
        },
      );
      expect(response.statusCode, response.payload).toBe(400);
      expect(response.payload).toMatch(/CSV row 3/);
      expect(response.payload).toContain('amount');
      const rows = await api
        .database()
        .query(
          'select count(*)::int count from app.workspace_data_table_rows where table_id=$1',
          [id],
        );
      expect(rows.rows).toEqual([{ count: 0 }]);
      const good = await api.send(
        'POST',
        `${f.root}/data-tables/${id}/import`,
        {
          browser: f.browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { csv: 'amount\n12\n13' },
        },
      );
      expect(good.statusCode, good.payload).toBe(200);
      expect(
        (
          await api
            .database()
            .query(
              'select count(*)::int count from app.workspace_data_table_rows where table_id=$1',
              [id],
            )
        ).rows,
      ).toEqual([{ count: 2 }]);
    });
  },
);
