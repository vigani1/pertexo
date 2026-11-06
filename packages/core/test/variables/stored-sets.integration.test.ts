import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { createWorkspaceVariablesStore } from '../../src/variables/workspace-variables.store.js';
import {
  readVariableSet,
  readVariableSetValues,
} from '../../src/variables/values.repository.js';
import { isStoredDataError } from '../../src/shared/stored-values.js';
import {
  identity,
  actorId,
  apiUrl,
  apiPool,
  parseDatabaseConfig,
  queryAsOwner,
} from '../support/workflow-authoring.js';
let store: ReturnType<typeof createWorkspaceVariablesStore>;
beforeAll(() => {
  store = createWorkspaceVariablesStore(
    parseDatabaseConfig({ connectionString: apiUrl }),
  );
});
afterAll(() => store.close());

it.each(['values', 'descriptions'] as const)(
  'decodes current and historical %s at their read boundaries',
  async (field) => {
    const workspaceId = (
      await identity.createWorkspaceWithOwner({
        name: 'Stored variable sets',
        slug: `vars-${randomUUID().slice(0, 8)}`,
        ownerUserId: actorId,
      })
    ).id;
    const scope = { workspaceId, actorId };
    await store.replace({
      ...scope,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      values: { RATE: 1 },
      descriptions: { RATE: 'Original' },
    });
    await store.replace({
      ...scope,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      values: { RATE: 2 },
      descriptions: { RATE: 'Current' },
    });
    const damage = async (revision: number) =>
      queryAsOwner(
        field === 'values'
          ? `update app.workspace_variable_set_revisions set values_json='{"RATE":{"nested":true}}'::jsonb where workspace_id=$1 and revision=$2`
          : `update app.workspace_variable_set_revisions set descriptions_json='{"RATE":42}'::jsonb where workspace_id=$1 and revision=$2`,
        [workspaceId, revision],
        workspaceId,
      );
    const read = (revision: number) =>
      withTenantScopedClient(apiPool, { workspaceId }, (client) =>
        readVariableSet(drizzle(client), workspaceId, revision),
      );
    await damage(1);
    expect(await store.read(scope)).toMatchObject({
      values: { RATE: 2 },
      descriptions: { RATE: 'Current' },
    });
    const historical = await read(1).catch((error: unknown) => error);
    expect(isStoredDataError(historical)).toBe(true);
    const execution = await withTenantScopedClient(
      apiPool,
      { workspaceId },
      (client) => readVariableSetValues(drizzle(client), workspaceId, 1),
    ).catch((error: unknown) => error);
    expect(isStoredDataError(execution)).toBe(true);
    await damage(2);
    const current = await store.read(scope).catch((error: unknown) => error);
    expect(isStoredDataError(current)).toBe(true);
    expect(
      await withTenantScopedClient(apiPool, { workspaceId }, (client) =>
        readVariableSetValues(drizzle(client), workspaceId, null),
      ),
    ).toEqual({});
  },
);
