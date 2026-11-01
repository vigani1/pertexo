import { randomUUID } from 'node:crypto';

import { dataTableNewColumnsSchema } from '@pertexo/node-sdk';
import type { Role } from '@pertexo/workflow-model';

import {
  actorId,
  identity,
  queryAsOwner,
} from '../../support/workflow-authoring.js';
import { query, store } from '../records/fixture.js';

export type Actor = Readonly<{ workspaceId: string; actorId: string }>;

export const orderColumns = dataTableNewColumnsSchema.parse([
  { name: 'key', type: 'text', required: true },
  { name: 'amount', type: 'number' },
  { name: 'active', type: 'boolean' },
]);

/** Its own workspace, so one test's limits, status and counters touch no other. */
export async function newWorkspace(): Promise<Actor> {
  const created = await identity.createWorkspaceWithOwner({
    id: randomUUID(),
    name: 'Data table rules',
    slug: `table-rules-${randomUUID()}`,
    ownerUserId: actorId,
    idempotencyKey: randomUUID(),
  });
  return { workspaceId: created.id, actorId };
}

export async function addMember(
  workspaceId: string,
  role: Role,
  status: 'active' | 'suspended' | 'removed' = 'active',
): Promise<Actor> {
  const id = randomUUID();
  await identity.createUser({
    id,
    email: `${id}@example.test`,
    displayName: `Table ${role}`,
  });
  await queryAsOwner(
    'insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,$4)',
    [workspaceId, id, role, status],
    workspaceId,
  );
  return { workspaceId, actorId: id };
}

export async function ordersTable(actor: Actor, keyColumn: string | null) {
  const name = `Orders_${randomUUID().replaceAll('-', '')}`;
  const { id } = await store.create({
    ...actor,
    idempotencyKey: randomUUID(),
    name,
    columns: orderColumns,
    keyColumn,
  });
  return { id, name };
}

export function insertOrder(
  actor: Actor,
  table: Readonly<{ id: string; name: string }>,
  key: string,
  amount = 1,
) {
  return store.write({
    ...actor,
    tableId: table.id,
    idempotencyKey: randomUUID(),
    command: {
      operation: 'insert',
      table: table.name,
      values: { key, amount, active: true },
    },
  });
}

/** Everything a caller can see of a workspace's tables and one table's rows. */
export async function snapshot(actor: Actor, tableId: string) {
  const { tables, quotas } = await store.list(actor);
  const { rows } = await store.find({ ...actor, tableId, query });
  return { tables, quotas, rows };
}

export async function revisionOf(actor: Actor, tableId: string) {
  const { tables } = await store.list(actor);
  const table = tables.find(({ id }) => id === tableId);
  if (table === undefined) throw new Error('Table missing');
  return table.revision;
}

export async function exportCsv(actor: Actor, tableId: string) {
  let csv = '';
  await store.exportCsv({
    ...actor,
    tableId,
    query: { filters: [] },
    consume: async (chunks) => {
      for await (const chunk of chunks) csv += chunk;
    },
  });
  return csv;
}
