import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, expect } from 'vitest';
import {
  verifyCuratedFixtureOwnership,
  recheckCuratedFixtureOwnership,
  type CuratedOwnedFixture,
} from '../../../../infrastructure/testing/curated-template-owned-fixture.mjs';
import { useBetterAuthRealApi } from './better-auth-real-api.integration.support.js';

/** Separate application/counter namespace per suite; real limits remain intact. */
export function useOrganizationOwnedApi(
  suite: string,
  options: Readonly<{
    publicWebOrigin?: string;
    beforeClose?: () => Promise<void>;
  }> = {},
) {
  let ownership: CuratedOwnedFixture;
  beforeAll(async () => {
    for (const name of [
      'DATABASE_ADMIN_URL',
      'DATABASE_MIGRATION_URL',
      'DATABASE_API_URL',
      'REDIS_URL',
    ])
      if (process.env[name] === undefined)
        throw new Error(`Explicit owned ${name} is required`);
    ownership = await verifyCuratedFixtureOwnership();
  });
  const api = useBetterAuthRealApi(suite, {
    ...options,
    databaseNamespace: 'f07_organization',
    workflowOrganization: {
      cursorSigningKey: Buffer.alloc(32, 0x7a).toString('base64'),
    },
    afterMigration: async (url) => {
      await recheckCuratedFixtureOwnership(ownership);
      const pool = new Pool({
        connectionString: url(process.env.DATABASE_ADMIN_URL ?? ''),
      });
      try {
        await pool.query(
          'update app.workflow_organization_rollout set writes_enabled=true',
        );
      } finally {
        await pool.end();
      }
    },
    beforeDrop: () => recheckCuratedFixtureOwnership(ownership),
  });
  async function fixture() {
    const email = `${randomUUID()}@example.test`;
    await api.signUp(email, '/login?verified=true');
    const browser = await api.signIn(email);
    const workspace = await api.send('POST', '/v1/workspaces', {
      browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: { name: 'Owned F07 HTTP', slug: `f07-${randomUUID()}` },
    });
    expect(workspace.statusCode, workspace.payload).toBe(201);
    const workspaceId = workspace.json<{ id: string }>().id;
    const route = `/v1/workspaces/${workspaceId}`;
    const created = await api.send('POST', `${route}/workflows`, {
      browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: { name: 'Literal Ops%_\\' },
    });
    expect(created.statusCode, created.payload).toBe(201);
    const workflowId = created.json<{ workflow: { id: string } }>().workflow.id;
    return { browser, workspaceId, workflowId, route };
  }

  return { api, fixture };
}
