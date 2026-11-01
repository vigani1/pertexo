import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  actorId,
  workspaceId,
  queryAsOwner,
  apiPool,
  workflowId,
} from '../../support/workflow-authoring.js';
import {
  withWorkspaceTransaction,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import {
  dataTableReferenceIssues,
  requireRunTableReferences,
} from '../../../src/data-tables/columns/references.queries.js';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import { store, scope, create, current, edit } from './fixture.js';

export function registerChecksSingletonMultipleTableBindings(): void {
  it('checks singleton/multiple table bindings before published starts, including nested bodies', async () => {
    const first = await create(),
      second = await create();
    const step = (id: string, table: string) => ({
      id,
      definition: { key: 'core.table_find', version: 1 },
      configVersion: 1,
      config: { table, columnBindings: { amount: 'amount' } },
      inputMappings: {},
      connectionRefs: {},
      position: { x: 0, y: 0 },
    });
    const graph: WorkflowGraph = {
      nodes: [
        step('first', first.name),
        {
          id: 'loop',
          definition: { key: 'core.for_each', version: 1 },
          configVersion: 1,
          config: {},
          inputMappings: {},
          connectionRefs: {},
          position: { x: 0, y: 0 },
          structured: {
            kind: 'for_each',
            maxIterations: 1,
            maxConcurrency: 1,
            body: {
              settings: {},
              nodes: [step('nested', second.name)],
              edges: [],
              inputPorts: ['in'],
              outputPorts: ['out'],
            },
          },
        },
      ],
      edges: [],
      settings: {},
    };
    const version = randomUUID();
    await queryAsOwner(
      'insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) select $1,$2,$3,coalesce(max(version_number),0)+1,$4::jsonb,$5::jsonb,$6,$7 from app.workflow_versions where workflow_id=$3',
      [
        version,
        workspaceId,
        workflowId,
        JSON.stringify(graph),
        JSON.stringify({ graph }),
        `wf:sha256:${'b'.repeat(64)}`,
        actorId,
      ],
      workspaceId,
    );
    const check = () =>
      withWorkspaceTransaction(apiPool, workspaceId, (transaction) =>
        requireRunTableReferences(transaction, version),
      );
    await check();
    await edit(first.id, {
      operation: 'rename_column',
      columnId: 'amount',
      name: 'total',
    });
    await check();
    await edit(second.id, {
      operation: 'remove_column',
      columnId: 'amount',
      confirm: true,
    });
    await expect(check()).rejects.toThrow('Mapped column amount');
    const issues = await withTenantScopedClient(apiPool, scope(), (client) =>
      dataTableReferenceIssues(client, workspaceId, graph),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toContain('structured.body');
  });

  it('changes all 100,000 rows within the existing bounds with exact counters', async () => {
    const table = await create();
    await store.configure({
      ...scope(),
      tableLimit: 20,
      columnLimit: 20,
      rowLimit: 100000,
      byteLimit: 52428800,
      idempotencyKey: randomUUID(),
    });
    for (let offset = 0; offset < 100000; offset += 1000)
      await store.importRows({
        ...scope(),
        tableId: table.id,
        idempotencyKey: randomUUID(),
        rows: Array.from({ length: 1000 }, (_, index) => ({
          key: `r${String(offset + index)}`,
          amount: offset + index,
        })),
      });
    const started = performance.now();
    await edit(table.id, {
      operation: 'rename_column',
      columnId: 'amount',
      name: 'total',
    });
    const renameMillis = performance.now() - started;
    const facts = await queryAsOwner<{
      count: number;
      bytes: string;
      changed: number;
    }>(
      "select count(*)::int count,sum(octet_length(values_json))::text bytes,count(*) filter(where values_json::jsonb ? 'total' and not values_json::jsonb ? 'amount')::int changed from app.workspace_data_table_rows where table_id=$1",
      [table.id],
    );
    const changed = await current(table.id);
    expect(facts[0]?.count).toBe(100000);
    expect(facts[0]?.changed).toBe(100000);
    expect(changed.storedBytes).toBe(Number(facts[0]?.bytes));
    process.stdout.write(
      `F14 schema maximum evidence ${JSON.stringify({ rows: changed.rowCount, renameMillis, storedBytes: changed.storedBytes })}\n`,
    );
  }, 90000);
}
