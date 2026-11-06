import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  betterAuthIntegrationEnabled,
  expectProblem,
  useBetterAuthRealApi,
} from '../../support/better-auth/real-api.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'stored workspace text at the authenticated API',
  () => {
    const api = useBetterAuthRealApi('stored_text');
    it('refuses lossy or unstoreable names and reasons without changing PostgreSQL rows', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const browser = await api.signIn(email);
      const validName = 'Équipe 😀';
      const create = (name: string) =>
        api.send('POST', '/v1/workspaces', {
          browser,
          headers: { 'idempotency-key': randomUUID() },
          payload: { name, slug: `text-${randomUUID().slice(0, 8)}` },
        });
      const created = await create(`  ${validName}  `);
      expect(created.statusCode, created.payload).toBe(201);
      const workspaceId = created.json<{ id: string }>().id;
      const before = await api
        .database()
        .query(
          'select id,name,status,revision,deletion_reason from app.workspaces order by id',
        );
      for (const invalid of ['bad\0name', 'bad\ud800name', 'bad\udc00name']) {
        expectProblem(await create(invalid), 400, 'request.invalid');
        expectProblem(
          await api.send('PATCH', `/v1/workspaces/${workspaceId}`, {
            browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: { name: invalid, expectedRevision: 1 },
          }),
          400,
          'request.invalid',
        );
        expectProblem(
          await api.send('POST', `/v1/workspaces/${workspaceId}/deletion`, {
            browser,
            headers: { 'idempotency-key': randomUUID() },
            payload: { reason: invalid },
          }),
          400,
          'request.invalid',
        );
      }
      expect(
        (
          await api
            .database()
            .query(
              'select id,name,status,revision,deletion_reason from app.workspaces order by id',
            )
        ).rows,
      ).toEqual(before.rows);
      expect(before.rows).toEqual([
        expect.objectContaining({
          id: workspaceId,
          name: validName,
          status: 'active',
          revision: 1,
          deletion_reason: null,
        }),
      ]);
      const longest = '😀'.repeat(64);
      const boundary = await create(longest);
      expect(boundary.statusCode, boundary.payload).toBe(201);
      expect(
        (
          await api
            .database()
            .query('select name from app.workspaces where id=$1', [
              boundary.json<{ id: string }>().id,
            ])
        ).rows,
      ).toEqual([{ name: longest }]);
      expectProblem(await create('x'.repeat(129)), 400, 'request.invalid');
    });
  },
);
