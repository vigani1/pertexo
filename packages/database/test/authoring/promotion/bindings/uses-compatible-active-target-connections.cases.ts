import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  actorId,
  otherActorId,
  workspaceId,
  otherWorkspaceId,
  emptyGraph,
} from '../../../support/workflow-authoring.js';
import {
  readVariableSet,
  setVariableSet,
} from '../../../support/variable-sets.js';
import {
  db,
  tables,
  scope,
  promotions,
  node,
  published,
  connection,
  promote,
} from './fixture.js';

export function registerUsesCompatibleActiveTargetConnections(): void {
  it('uses only compatible active target connections by normalized name, and never copies credential bytes', async () => {
    const name = `HTTP ${randomUUID()}`;
    const sourceId = await connection(workspaceId, actorId, name);
    const selected = await published({
      ...emptyGraph,
      nodes: [
        {
          ...node('service', 'test.placeholder'),
          connectionRefs: { service: sourceId },
        },
      ],
    });
    const missing = await promotions().preview({
      ...scope(),
      selections: [selected],
      mode: 'draft',
    });
    expect(missing.compatible).toBe(false);
    expect(missing.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'connection', status: 'missing' }),
      ]),
    );
    const targetId = await connection(
      otherWorkspaceId,
      otherActorId,
      ` ${name.toUpperCase()} `,
    );
    const { review, item } = await promote(selected);
    expect(
      review.workflows[0]?.proposedGraph.nodes[0]?.connectionRefs.service,
    ).toBe(targetId);
    expect(JSON.stringify(review)).not.toContain('PRIVATE_');
    expect(JSON.stringify(review)).not.toContain(sourceId);
    expect(
      (await db.getDraft(otherWorkspaceId, item.targetWorkflowId, actorId))
        ?.graphJson.nodes[0]?.connectionRefs.service,
    ).toBe(targetId);
  });

  it('requires target variables without copying source values and makes changed names stale', async () => {
    await setVariableSet(scope().workspaceId, { RATE: 42 });
    const selection = await published({
      ...emptyGraph,
      nodes: [
        {
          ...node('calc', 'core.terminate'),
          inputMappings: {
            value: { kind: 'workspace_variable', name: 'RATE' },
          },
        },
      ],
    });
    expect(
      (
        await promotions().preview({
          ...scope(),
          selections: [selection],
          mode: 'draft',
        })
      ).requirements,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'variable',
          name: 'RATE',
          status: 'missing',
        }),
      ]),
    );
    await setVariableSet(otherWorkspaceId, { RATE: 7 });
    const { review } = await promote(selection);
    expect((await readVariableSet(otherWorkspaceId)).RATE).toBe(7);
    expect(JSON.stringify(review)).not.toContain('"RATE":42');
    await setVariableSet(otherWorkspaceId, { OTHER: 7 });
    await expect(
      promotions().apply({
        ...scope(),
        selections: [selection],
        mode: 'draft',
        fingerprint: review.fingerprint,
        acknowledgeTargetChanges: [],
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'stale' });
  });

  it('rebinds renamed stable table IDs by current name while preserving old output aliases', async () => {
    const name = `Amounts_${randomUUID().replaceAll('-', '')}`;
    const columns = [
      { name: 'key', type: 'text' as const, required: true },
      { name: 'amount', type: 'number' as const, required: true },
    ];
    const source = await tables.create({
      ...scope(),
      name,
      columns,
      keyColumn: 'key',
      idempotencyKey: randomUUID(),
    });
    await tables.editSchema({
      ...scope(),
      tableId: source.id,
      expectedRevision: 1,
      change: { operation: 'rename_column', columnId: 'amount', name: 'total' },
      idempotencyKey: randomUUID(),
    });
    const targetScope = {
      workspaceId: otherWorkspaceId,
      actorId: otherActorId,
    };
    const target = await tables.create({
      ...targetScope,
      name,
      columns: [
        columns[0] ?? { name: 'key', type: 'text', required: true },
        { name: 'total', type: 'number', required: true },
      ],
      keyColumn: 'key',
      idempotencyKey: randomUUID(),
    });
    const selection = await published({
      ...emptyGraph,
      nodes: [
        node('find', 'core.table_find', {
          table: name,
          columnBindings: { key: 'key', amount: 'amount' },
        }),
      ],
    });
    const { review } = await promote(selection);
    expect(review.workflows[0]?.proposedGraph.nodes[0]?.config).toEqual({
      table: name,
      columnBindings: { key: 'key', amount: 'total' },
    });
    expect(
      (await tables.list(targetScope)).tables.find(
        (table) => table.id === target.id,
      )?.rowCount,
    ).toBe(0);
    await tables.editSchema({
      ...targetScope,
      tableId: target.id,
      expectedRevision: 1,
      change: { operation: 'remove_column', columnId: 'total', confirm: true },
      idempotencyKey: randomUUID(),
    });
    expect(
      (
        await promotions().preview({
          ...scope(),
          selections: [selection],
          mode: 'draft',
        })
      ).compatible,
    ).toBe(false);
  });
}
