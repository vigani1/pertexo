import { randomUUID } from 'node:crypto';

import type { Role } from '@pertexo/workflow-model';
import { expect, it } from 'vitest';

import { WorkspaceAccessDeniedError } from '../../../src/tenant-access/errors.js';
import { store } from '../records/fixture.js';
import {
  addMember,
  exportCsv,
  insertOrder,
  newWorkspace,
  orderColumns,
  ordersTable,
  revisionOf,
  snapshot,
  type Actor,
} from './world.js';

type Table = Readonly<{ id: string; name: string }>;

export const LIMITS = {
  tableLimit: 25,
  columnLimit: 25,
  rowLimit: 2000,
  byteLimit: 1_048_576,
};

/** Every table change a member can ask for, keyed so a refusal names which one. */
export function changes(actor: Actor, owner: Actor, table: Table) {
  const once = () => ({ ...actor, idempotencyKey: randomUUID() });
  return {
    create: () =>
      store.create({
        ...once(),
        name: `New_${randomUUID().replaceAll('-', '')}`,
        columns: orderColumns,
        keyColumn: null,
      }),
    write: () =>
      store.write({
        ...once(),
        tableId: table.id,
        command: {
          operation: 'insert',
          table: table.name,
          values: { key: randomUUID(), amount: 1 },
        },
      }),
    importRows: () =>
      store.importRows({
        ...once(),
        tableId: table.id,
        rows: [{ key: randomUUID(), amount: 1 }],
      }),
    editSchema: async () =>
      store.editSchema({
        ...once(),
        tableId: table.id,
        expectedRevision: await revisionOf(owner, table.id),
        change: {
          operation: 'rename_column',
          columnId: 'amount',
          name: `amount_${randomUUID().slice(0, 8)}`,
        },
      }),
  };
}

export async function worldWithRow() {
  const owner = await newWorkspace();
  const table = await ordersTable(owner, 'key');
  await insertOrder(owner, table, 'seen', 3);
  return { owner, table };
}

/** What every member of a workspace can see of a table with one row, `seen`. */
export async function expectReadsShowTheRow(actor: Actor, table: Table) {
  const { tables } = await store.list(actor);
  expect(tables.find(({ id }) => id === table.id)).toMatchObject({
    name: table.name,
    rowCount: 1,
  });
  const found = await store.find({
    ...actor,
    tableId: table.id,
    query: { filters: [], limit: 10, offset: 0 },
  });
  expect(found.rows.map(({ values }) => values)).toEqual([
    { key: 'seen', amount: 3, active: true },
  ]);
  const csv = await exportCsv(actor, table.id);
  expect(csv).toContain('seen');
}

export async function expectReadsRefused(actor: Actor, table: Table) {
  await expect(store.list(actor)).rejects.toBeInstanceOf(
    WorkspaceAccessDeniedError,
  );
  await expect(
    store.find({
      ...actor,
      tableId: table.id,
      query: { filters: [], limit: 10, offset: 0 },
    }),
  ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  await expect(exportCsv(actor, table.id)).rejects.toBeInstanceOf(
    WorkspaceAccessDeniedError,
  );
}

export async function expectChangesRefused(
  actor: Actor,
  owner: Actor,
  table: Table,
) {
  const before = await snapshot(owner, table.id);
  for (const [name, change] of Object.entries(changes(actor, owner, table)))
    await expect(change(), name).rejects.toBeInstanceOf(
      WorkspaceAccessDeniedError,
    );
  await expect(
    store.configure({
      ...actor,
      idempotencyKey: randomUUID(),
      ...LIMITS,
    }),
  ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  await expect(
    store.remove({
      ...actor,
      idempotencyKey: randomUUID(),
      tableId: table.id,
      expectedRevision: await revisionOf(owner, table.id),
    }),
  ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  expect(await snapshot(owner, table.id)).toEqual(before);
}

const ROLE_CASES: readonly [Role, boolean, boolean][] = [
  ['owner', true, true],
  ['admin', true, true],
  ['builder', true, false],
  ['operator', false, false],
  ['viewer', false, false],
];

export function registerAccess(): void {
  it.each(ROLE_CASES)(
    'as %s: reads hold, edits rows and schema: %s, changes limits: %s',
    async (role, canEdit, canConfigure) => {
      const { owner, table } = await worldWithRow();
      // A workspace has exactly one owner.
      const member =
        role === 'owner' ? owner : await addMember(owner.workspaceId, role);

      await expectReadsShowTheRow(member, table);

      const before = await snapshot(owner, table.id);
      for (const [name, change] of Object.entries(
        changes(member, owner, table),
      )) {
        if (canEdit) await expect(change(), name).resolves.toBeDefined();
        else
          await expect(change(), name).rejects.toBeInstanceOf(
            WorkspaceAccessDeniedError,
          );
      }
      if (!canEdit) expect(await snapshot(owner, table.id)).toEqual(before);

      const limits = store.configure({
        ...member,
        idempotencyKey: randomUUID(),
        ...LIMITS,
      });
      if (canConfigure) {
        await expect(limits).resolves.toMatchObject(LIMITS);
        expect((await store.list(owner)).quotas).toMatchObject(LIMITS);
      } else {
        await expect(limits).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
        expect((await store.list(owner)).quotas.rowLimit).not.toBe(
          LIMITS.rowLimit,
        );
      }

      const removal = store.remove({
        ...member,
        idempotencyKey: randomUUID(),
        tableId: table.id,
        expectedRevision: await revisionOf(owner, table.id),
      });
      if (canEdit) await expect(removal).resolves.toEqual({ removed: true });
      else
        await expect(removal).rejects.toBeInstanceOf(
          WorkspaceAccessDeniedError,
        );
    },
  );

  it.each(['removed', 'suspended'] as const)(
    'lets a %s member neither read nor write',
    async (status) => {
      const { owner, table } = await worldWithRow();
      const member = await addMember(owner.workspaceId, 'builder', status);
      await expectReadsRefused(member, table);
      await expectChangesRefused(member, owner, table);
    },
  );

  it('lets someone who never joined neither read nor write', async () => {
    const { owner, table } = await worldWithRow();
    const other = await newWorkspace();
    const stranger = await addMember(other.workspaceId, 'admin');
    const outsider = {
      workspaceId: owner.workspaceId,
      actorId: stranger.actorId,
    };
    await expectReadsRefused(outsider, table);
    await expectChangesRefused(outsider, owner, table);
  });
}
