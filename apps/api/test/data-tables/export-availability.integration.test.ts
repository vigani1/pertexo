import { randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

const origin = 'https://export-availability.integration.test';
describe.runIf(betterAuthIntegrationEnabled)(
  'table exports through a one-connection serving pool',
  () => {
    const api = useBetterAuthRealApi('exports', {
      databasePoolMax: 1,
      publicWebOrigin: origin,
    });
    it('keeps authenticated table queries responsive while a download client stops reading', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const browser = await api.signIn(email);
      const workspace = await api.send('POST', '/v1/workspaces', {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Exports',
          slug: `exports-${randomUUID().slice(0, 8)}`,
        },
      });
      expect(workspace.statusCode, workspace.payload).toBe(201);
      const workspaceId = workspace.json<{ id: string }>().id;
      const path = `/v1/workspaces/${workspaceId}/data-tables`;
      const created = await api.send('POST', path, {
        browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Orders',
          columns: [{ name: 'note', type: 'text', required: true }],
        },
      });
      expect(created.statusCode, created.payload).toBe(200);
      const tableId = created.json<{ id: string }>().id;
      const database = api.database();
      await database.query(
        `insert into app.workspace_data_table_rows(workspace_id,table_id,id,values_json)
      select $1,$2,gen_random_uuid(),jsonb_build_object('note',repeat('x',20000))::text from generate_series(1,1000)`,
        [workspaceId, tableId],
      );
      await database.query(
        `update app.workspace_data_tables set row_count=1000,stored_bytes=(select sum(octet_length(values_json)) from app.workspace_data_table_rows where workspace_id=$1 and table_id=$2) where workspace_id=$1 and id=$2`,
        [workspaceId, tableId],
      );
      await database.query(
        `update app.workspace_data_table_quotas set stored_bytes=(select stored_bytes from app.workspace_data_tables where workspace_id=$1 and id=$2) where workspace_id=$1`,
        [workspaceId, tableId],
      );
      const base = await api.listen();
      const headers = {
        cookie: browser.cookie,
        'x-csrf-token': browser.csrf,
        origin,
        'content-type': 'application/json',
      };
      const pending = Promise.withResolvers<IncomingMessage>();
      const request = httpRequest(
        `${base}${path}/${tableId}/export`,
        { method: 'POST', headers },
        pending.resolve,
      );
      request.on('error', pending.reject);
      request.end(JSON.stringify({ filters: [] }));
      const download = await pending.promise;
      download.on('error', () => undefined);
      try {
        expect(download.statusCode).toBe(200);
        expect(download.headers['content-disposition']).toContain(
          'Orders-rows.csv',
        );
        // The native client deliberately never reads. A long-lived export transaction
        // holds the store's only connection already, even before TCP buffers fill.
        for (let i = 0; i < 3; i++) {
          const response = await fetch(`${base}${path}/${tableId}/rows/query`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ filters: [], limit: 1, offset: 0 }),
            signal: AbortSignal.timeout(3000),
          });
          expect(response.status).toBe(200);
          expect(
            ((await response.json()) as { rows: unknown[] }).rows,
          ).toHaveLength(1);
        }
        const audit = await fetch(
          `${base}/v1/workspaces/${workspaceId}/governance/settings`,
          { headers, signal: AbortSignal.timeout(3000) },
        );
        expect(audit.status).toBe(200);
        const competingAudit = await fetch(
          `${base}/v1/workspaces/${workspaceId}/governance/audit/export`,
          {
            method: 'POST',
            headers,
            body: '{}',
            signal: AbortSignal.timeout(3000),
          },
        );
        expect(competingAudit.status).toBe(409);
        const extra = await fetch(`${base}${path}/${tableId}/export`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ filters: [] }),
          signal: AbortSignal.timeout(3000),
        });
        expect(extra.status).toBe(409);
        expect(extra.headers.get('content-disposition')).toBeNull();
        expect(await extra.text()).toContain('export is already running');
      } finally {
        download.destroy();
        request.destroy();
      }
    });
  },
);
