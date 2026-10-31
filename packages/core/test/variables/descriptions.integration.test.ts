import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  actorId,
  workspaceId,
  apiUrl,
  parseDatabaseConfig,
  randomUUID,
  queryAsOwner,
} from '../../../database/test/support/workflow-authoring.js';
import { createWorkspaceVariablesStore } from '../../src/variables/settings.repository.js';
import { readVariableSetValues } from '../../../database/src/variables/values.queries.js';
import { withTenantScopedClient } from '../../../database/src/tenant-access/transactions.js';
import { Pool } from 'pg';
import { workspaceVariablesRequestSchema } from '@pertexo/contracts';
import { IdempotencyConflictError } from '@pertexo/database/platform';
let store: ReturnType<typeof createWorkspaceVariablesStore>;
beforeAll(() => {
  store = createWorkspaceVariablesStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  );
});
afterAll(() => store.close());
it('versions descriptions with values, preserves omitted metadata and audits names only', async () => {
  const scope = { workspaceId, actorId };
  const first = {
    ...scope,
    idempotencyKey: randomUUID(),
    ...workspaceVariablesRequestSchema.parse({
      expectedRevision: 0,
      values: { RATE: 10, EMPTY: '' },
      descriptions: {
        RATE: '  Private description for members  ',
        EMPTY: '   ',
      },
    }),
  };
  expect(await store.replace(first)).toMatchObject({
    revision: 1,
    changed: true,
    replayed: false,
  });
  expect(await store.read(scope)).toEqual({
    revision: 1,
    values: first.values,
    descriptions: { RATE: 'Private description for members' },
  });
  const metadata = {
    ...first,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    descriptions: { RATE: 'Changed metadata, same value.' },
  };
  expect(await store.replace(metadata)).toMatchObject({
    revision: 2,
    changed: true,
  });
  expect(await store.replace(first)).toMatchObject({
    revision: 1,
    replayed: true,
  });
  await expect(
    store.replace({ ...metadata, descriptions: { RATE: 'different' } }),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  const oldClient = {
    ...scope,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
    values: { RATE: 20, EMPTY: '' },
  };
  expect(await store.replace(oldClient)).toMatchObject({
    revision: 3,
    changed: true,
  });
  expect(await store.read(scope)).toEqual({
    revision: 3,
    values: oldClient.values,
    descriptions: metadata.descriptions,
  });
  expect(
    await store.replace({
      ...oldClient,
      expectedRevision: 3,
      idempotencyKey: randomUUID(),
    }),
  ).toMatchObject({ revision: 3, changed: false });
  expect(
    await store.replace({
      ...oldClient,
      expectedRevision: 3,
      idempotencyKey: randomUUID(),
      descriptions: {},
    }),
  ).toMatchObject({ revision: 4, changed: true });
  expect(await store.read(scope)).toEqual({
    revision: 4,
    values: oldClient.values,
    descriptions: {},
  });
  await store.replace({
    ...scope,
    expectedRevision: 4,
    idempotencyKey: randomUUID(),
    values: { RATE: 20, EMPTY: '' },
    descriptions: { RATE: 'Remove with the value' },
  });
  await store.replace({
    ...scope,
    expectedRevision: 5,
    idempotencyKey: randomUUID(),
    values: { EMPTY: '' },
  });
  expect(await store.read(scope)).toEqual({
    revision: 6,
    values: { EMPTY: '' },
    descriptions: {},
  });
  const rows = await queryAsOwner(
    'select revision,values_json,descriptions_json from app.workspace_variable_set_revisions where workspace_id=$1 order by revision',
    [workspaceId],
  );
  expect(rows).toHaveLength(6);
  expect(rows[0]).toEqual({
    revision: 1,
    values_json: first.values,
    descriptions_json: { RATE: 'Private description for members' },
  });
  expect(rows[1]).toEqual({
    revision: 2,
    values_json: first.values,
    descriptions_json: metadata.descriptions,
  });
  const audits = await queryAsOwner<{ metadata: unknown }>(
    "select metadata from app.audit_events where workspace_id=$1 and action='workspace.variables_changed' order by occurred_at,id",
    [workspaceId],
    workspaceId,
  );
  expect(audits).toEqual(
    [['EMPTY', 'RATE'], ['RATE'], ['RATE'], ['RATE'], ['RATE'], ['RATE']].map(
      (changedNames, index) => ({
        metadata: { revision: index + 1, changedNames },
      }),
    ),
  );
  expect(JSON.stringify(audits)).not.toContain('description');
  expect(JSON.stringify(audits)).not.toContain('metadata, same value');
});

it('distinguishes the fixed empty snapshot from a missing historical revision', async () => {
  const pool = new Pool({ connectionString: apiUrl, max: 1 });
  try {
    await withTenantScopedClient(
      pool,
      { workspaceId, actorId },
      async (client) => {
        expect(
          await readVariableSetValues(drizzle(client), workspaceId, null),
        ).toEqual({});
        await expect(
          readVariableSetValues(drizzle(client), workspaceId, 999_999),
        ).rejects.toThrow('Workspace variable revision is missing');
      },
    );
  } finally {
    await pool.end();
  }
});
