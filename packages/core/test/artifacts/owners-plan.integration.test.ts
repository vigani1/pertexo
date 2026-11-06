import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { artifactReferenceOwnersSql } from '../../src/artifacts/references/owners.repository.js';
import { readFolderScope } from '../../src/shared/folder-access-facts.repository.js';
import { workflowScopeSql } from '../../src/shared/folder-scope.repository.js';
import { artifactOwnerFixture } from './owner-shapes.fixture.js';
import { ownerTransaction } from './lifetime.fixture.js';
import { workspaceId, userId } from '../lifecycle/retention.support.js';

interface Plan {
  'Relation Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  Plans?: Plan[];
}
function scans(plan: Plan): Plan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(scans)];
}

it('reads no owner documents for negative access and retention probes across 500 drafts and 10,000 candidates', async () => {
  const state = await artifactOwnerFixture('draft', 'business-id');
  const graph = {
    ...state.graph,
    note: 'x'.repeat(32_768),
    nodes: state.graph.nodes.map((node) => ({
      ...node,
      inputMappings: {
        file: {
          kind: 'literal',
          value: Array.from({ length: 20 }, () => ({
            ...state.reference,
            artifactId: randomUUID(),
          })),
        },
      },
    })),
  };
  try {
    await ownerTransaction(async (client) => {
      await client.query(
        `with owners as (
          insert into app.workflows(id,workspace_id,name,created_by)
          select gen_random_uuid(),$1,'Owner plan '||n,$2 from generate_series(1,500) n returning id
        ) insert into app.workflow_drafts(workspace_id,workflow_id,revision,graph_json,updated_by)
          select $1,id,1,$3::json,$2 from owners`,
        [workspaceId, userId, JSON.stringify(graph)],
      );
      await client.query('analyze app.artifact_owner_references');
    });
    const candidates = Array.from({ length: 10_000 }, () => randomUUID());
    await withTenantScopedClient(
      state.pool,
      { workspaceId },
      async (client) => {
        const scope = await readFolderScope(client, {
          workspaceId,
          actorId: userId,
        });
        for (const visibility of [
          undefined,
          (workflow: ReturnType<typeof sql>) =>
            workflowScopeSql(scope, workflow),
        ]) {
          for (const ids of [candidates.slice(0, 1), candidates]) {
            const statement = new QueryBuilder()
              .select({
                owned: artifactReferenceOwnersSql(
                  sql`${workspaceId}`,
                  sql`candidate.id`,
                  visibility,
                ),
              })
              .from(sql`unnest(${sql.param(ids)}::uuid[]) candidate(id)`)
              .toSQL();
            const result = await client.query<{ owned: boolean }>(
              statement.sql,
              statement.params,
            );
            expect(result.rows).toHaveLength(ids.length);
            expect(result.rows.every((row) => !row.owned)).toBe(true);
            const explain = await client.query<{
              'QUERY PLAN': { Plan: Plan }[];
            }>(
              `explain (analyze,buffers,format json) ${statement.sql}`,
              statement.params,
            );
            const plan = explain.rows[0]?.['QUERY PLAN'][0]?.Plan;
            if (!plan) throw new Error('Owner plan missing');
            const relations = scans(plan).filter(
              (node) => node['Relation Name'],
            );
            const references = relations.filter(
              (node) => node['Relation Name'] === 'artifact_owner_references',
            );
            // No scan of a JSON owner, or its authority/lifetime joins, may run on a miss.
            expect(
              relations
                .filter(
                  (node) =>
                    node['Relation Name'] !== 'artifact_owner_references',
                )
                .reduce(
                  (rows, node) =>
                    rows +
                    node['Actual Loops'] *
                      (node['Actual Rows'] +
                        (node['Rows Removed by Filter'] ?? 0)),
                  0,
                ),
            ).toBe(0);
            expect(references).toHaveLength(1);
            // A negative UUID probe reads zero index tuples, even with 10,000 stored references.
            expect(references[0]?.['Actual Rows']).toBe(0);
            expect(references[0]?.['Actual Loops']).toBeLessThanOrEqual(
              ids.length,
            );
            expect(references[0]?.['Rows Removed by Filter'] ?? 0).toBe(0);
          }
        }
      },
    );
  } finally {
    await state.close();
  }
}, 180_000);
