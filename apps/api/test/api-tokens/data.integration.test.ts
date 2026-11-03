import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  apiTokenCreateResponseSchema,
  type ApiTokenScope,
} from '@pertexo/contracts';
import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import { createAutomationApiFixture } from './api/fixture.js';
import { createTokenWorkspace } from './api/portability/setup.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'workspace data token operations',
  () => {
    const fixture = createAutomationApiFixture();

    it('reads and writes tables, variables and tag assignments with explicit scopes and isolated receipts', async () => {
      const { api } = fixture;
      const workspace = await createTokenWorkspace(fixture);
      async function credential(scopes: readonly ApiTokenScope[]) {
        const response = await api.send(
          'POST',
          `${workspace.base}/api-tokens`,
          {
            browser: workspace.browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: { name: 'Workspace data script', scopes },
          },
        );
        expect(response.statusCode, response.payload).toBe(201);
        const token = apiTokenCreateResponseSchema.parse(response.json());
        if (token.replayed) throw new Error('First token creation replayed');
        return { authorization: `Bearer ${token.secret}` };
      }
      const scopes = [
        'workflow:read',
        'workflow:update',
        'workspace:read',
        'variable:manage',
      ] as const;
      const first = await credential(scopes);
      const second = await credential(scopes);
      const readOnly = await credential(['workspace:read']);
      const tables = `${workspace.base}/data-tables`;
      const tableKey = randomUUID();
      const tableRequest = {
        name: 'Token orders',
        columns: [
          { name: 'key', type: 'text', required: true },
          { name: 'amount', type: 'number' },
        ],
        keyColumn: 'key',
      };
      const created = await api.send('POST', tables, {
        headers: { ...first, 'idempotency-key': tableKey },
        payload: tableRequest,
      });
      expect(created.statusCode, created.payload).toBe(201);
      const tableId = created.json<{ id: string }>().id;
      const table = `${tables}/${tableId}`;
      const replay = await api.send('POST', tables, {
        headers: { ...first, 'idempotency-key': tableKey },
        payload: tableRequest,
      });
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual({ id: tableId });
      for (const caller of [
        { headers: { ...second, 'idempotency-key': tableKey } },
        {
          browser: workspace.browser,
          headers: { 'idempotency-key': tableKey },
        },
      ]) {
        const response = await api.send('POST', tables, {
          ...caller,
          payload: tableRequest,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
          code: 'data_table.key_conflict',
        });
      }
      const writeKey = randomUUID();
      for (const [index, headers] of [first, second].entries()) {
        const response = await api.send('POST', `${table}/rows`, {
          headers: { ...headers, 'idempotency-key': writeKey },
          payload: {
            command: {
              operation: 'insert',
              table: tableRequest.name,
              values: { key: `row-${String(index)}`, amount: index },
            },
          },
        });
        expect(response.statusCode, response.payload).toBe(200);
        expect(response.json()).toMatchObject({ affected: 1 });
      }
      const imported = await api.send('POST', `${table}/import`, {
        headers: { ...first, 'idempotency-key': randomUUID() },
        payload: { csv: 'key,amount\ncsv-row,3\n' },
      });
      expect(imported.statusCode, imported.payload).toBe(200);
      expect(imported.json()).toEqual({ affected: 1 });
      const found = await api.send('POST', `${table}/rows/query`, {
        headers: readOnly,
        payload: { filters: [], limit: 100, offset: 0 },
      });
      expect(found.statusCode, found.payload).toBe(200);
      expect(found.json<{ rows: unknown[] }>().rows).toHaveLength(3);
      const beforeEdit = await api.send('GET', tables, { headers: readOnly });
      expect(beforeEdit.statusCode).toBe(200);
      const priorRevision = beforeEdit
        .json<{ tables: { id: string; revision: number }[] }>()
        .tables.find(({ id }) => id === tableId)?.revision;
      if (priorRevision === undefined)
        throw new Error('Table missing before edit');
      const schemaKey = randomUUID();
      const schemaChange = {
        expectedRevision: priorRevision,
        change: {
          operation: 'add_column',
          column: { name: 'note', type: 'text' },
        },
      };
      const edited = await api.send('PUT', `${table}/schema`, {
        headers: { ...first, 'idempotency-key': schemaKey },
        payload: schemaChange,
      });
      expect(edited.statusCode, edited.payload).toBe(200);
      expect(edited.json()).toEqual({ revision: priorRevision + 1 });
      const otherEdit = await api.send('PUT', `${table}/schema`, {
        headers: { ...second, 'idempotency-key': schemaKey },
        payload: schemaChange,
      });
      expect(otherEdit.statusCode).toBe(409);
      const listed = await api.send('GET', tables, { headers: readOnly });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({
        tables: [expect.objectContaining({ id: tableId, rowCount: 3 })],
      });
      for (const id of [tableId, randomUUID()]) {
        const denied = await api.send('POST', `${tables}/${id}/rows`, {
          headers: { ...readOnly, 'idempotency-key': randomUUID() },
          payload: {
            command: {
              operation: 'insert',
              table: tableRequest.name,
              values: { key: 'forbidden' },
            },
          },
        });
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).toMatchObject({
          code: 'auth.token_scope_required',
        });
      }
      for (const url of [`${tables}/limits`, `${table}/export`]) {
        const denied = await api.send(
          url.endsWith('limits') ? 'PUT' : 'POST',
          url,
          {
            headers: { ...first, 'idempotency-key': randomUUID() },
            payload: {},
          },
        );
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).toMatchObject({
          code: 'auth.token_not_supported',
        });
      }
      const removed = await api.send('DELETE', table, {
        headers: { ...first, 'idempotency-key': randomUUID() },
        payload: { expectedRevision: priorRevision + 1 },
      });
      expect(removed.statusCode, removed.payload).toBe(200);
      expect(removed.json()).toEqual({ removed: true });

      const variables = `${workspace.base}/variables`;
      const initial = await api.send('GET', variables, { headers: readOnly });
      expect(initial.statusCode).toBe(200);
      const variableKey = randomUUID();
      const replacement = {
        expectedRevision: initial.json<{ revision: number }>().revision,
        values: { REGION: 'eu' },
      };
      const replaced = await api.send('PUT', variables, {
        headers: { ...first, 'idempotency-key': variableKey },
        payload: replacement,
      });
      expect(replaced.statusCode, replaced.payload).toBe(200);
      expect(replaced.json()).toMatchObject({ changed: true, replayed: false });
      const replacementReplay = await api.send('PUT', variables, {
        headers: { ...first, 'idempotency-key': variableKey },
        payload: replacement,
      });
      expect(replacementReplay.json()).toMatchObject({ replayed: true });
      for (const caller of [
        { headers: { ...second, 'idempotency-key': variableKey } },
        {
          browser: workspace.browser,
          headers: { 'idempotency-key': variableKey },
        },
      ]) {
        const response = await api.send('PUT', variables, {
          ...caller,
          payload: replacement,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ code: 'variables.changed' });
      }
      const references = await api.send(
        'GET',
        `${variables}/usage?name=REGION`,
        { headers: first },
      );
      expect(references.statusCode, references.payload).toBe(200);
      const missingScope = await api.send(
        'GET',
        `${variables}/usage?name=REGION`,
        { headers: readOnly },
      );
      expect(missingScope.statusCode).toBe(403);
      expect(missingScope.json()).toMatchObject({
        code: 'auth.token_scope_required',
      });

      const tags = `${workspace.base}/workflow-tags`;
      const tag = await api.send('POST', tags, {
        browser: workspace.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { key: 'operations' },
      });
      expect(tag.statusCode, tag.payload).toBe(201);
      const tagId = tag.json<{ tag: { id: string } }>().tag.id;
      const tagList = await api.send('GET', tags, { headers: first });
      expect(tagList.statusCode).toBe(200);
      const assignmentPath = `${workspace.base}/workflows/${workspace.workflowId}/tags`;
      const tagKey = randomUUID();
      const assignment = { tagIds: [tagId], expectedOrganizationRevision: 1 };
      const assigned = await api.send('POST', assignmentPath, {
        headers: { ...first, 'idempotency-key': tagKey },
        payload: assignment,
      });
      expect(assigned.statusCode, assigned.payload).toBe(200);
      expect(assigned.json()).toMatchObject({
        tagIds: [tagId],
        organizationRevision: 2,
        replayed: false,
      });
      const assignmentReplay = await api.send('POST', assignmentPath, {
        headers: { ...first, 'idempotency-key': tagKey },
        payload: assignment,
      });
      expect(assignmentReplay.json()).toMatchObject({ replayed: true });
      for (const caller of [
        { headers: { ...second, 'idempotency-key': tagKey } },
        { browser: workspace.browser, headers: { 'idempotency-key': tagKey } },
      ]) {
        const response = await api.send('POST', assignmentPath, {
          ...caller,
          payload: assignment,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
          code: 'workflow.organization_revision_conflict',
        });
      }
      const assignments = await api.send('GET', `${tags}/${tagId}/workflows`, {
        headers: first,
      });
      expect(assignments.statusCode).toBe(200);
      expect(assignments.json()).toMatchObject({
        items: [expect.objectContaining({ workflowId: workspace.workflowId })],
      });
      const vocabulary = await api.send('POST', tags, {
        headers: { ...first, 'idempotency-key': randomUUID() },
        payload: { key: 'not-created' },
      });
      expect(vocabulary.statusCode).toBe(403);
      expect(vocabulary.json()).toMatchObject({
        code: 'auth.token_not_supported',
      });
    });
  },
);
