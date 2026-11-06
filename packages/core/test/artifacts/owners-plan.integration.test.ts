import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { artifactReferenceOwnersSql } from '../../src/artifacts/references/owners.repository.js';
import { artifactOwnerFixture } from './owner-shapes.fixture.js';
import { ownerTransaction } from './lifetime.fixture.js';
import { workspaceId, userId } from '../lifecycle/retention.support.js';

it('keeps a negative retained-owner lookup indexed and bounded across authored documents', async () => {
  const state = await artifactOwnerFixture('draft', 'business-id');
  const graph = {
    ...state.graph,
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
    await ownerTransaction((client) =>
      client.query(
        `with owners as (
      insert into app.workflows(id,workspace_id,name,created_by)
      select gen_random_uuid(),$1,'Owner plan '||n,$2 from generate_series(1,500) n returning id
    ) insert into app.workflow_drafts(workspace_id,workflow_id,revision,graph_json,updated_by)
      select $1,id,1,$3::json,$2 from owners`,
        [workspaceId, userId, JSON.stringify(graph)],
      ),
    );
    const statement = new QueryBuilder()
      .select({
        owned: artifactReferenceOwnersSql(
          sql`${workspaceId}`,
          sql`${state.reference.artifactId}`,
        ).as('owned'),
      })
      .from(sql`(select 1) probe`)
      .toSQL();
    const observations = await withTenantScopedClient(
      state.pool,
      { workspaceId },
      async (client) => {
        const result = await client.query<{ owned: boolean }>(
          statement.sql,
          statement.params,
        );
        expect(result.rows).toEqual([{ owned: false }]);
        const plans: Record<string, unknown>[] = [];
        for (let count = 0; count < 6; count++) {
          const result = await client.query<{
            'QUERY PLAN': Record<string, unknown>[];
          }>(
            `explain (analyze,buffers,format json) ${statement.sql}`,
            statement.params,
          );
          const plan = result.rows[0]?.['QUERY PLAN'][0];
          if (plan === undefined) throw new Error('Owner plan missing');
          plans.push(plan);
        }
        return plans;
      },
    );
    expect(JSON.stringify(observations[0])).toMatch(/Index (Only )?Scan/u);
    expect(Number(observations[0]?.['Execution Time'])).toBeLessThan(2_000);
  } finally {
    await state.close();
  }
}, 30_000);
