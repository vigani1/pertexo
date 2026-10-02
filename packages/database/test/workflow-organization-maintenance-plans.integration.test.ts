import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganizationOwnedFixture,
  organizationFixtureEnabled,
  type OrganizationOwnedFixture,
} from './support/workflow-organization-owned.fixture.js';

interface Plan {
  'Node Type': string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows'?: number;
  Plans?: Plan[];
}
function nodes(plan: Plan): Plan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

describe.skipIf(!organizationFixtureEnabled)(
  'owned F07 sparse maintenance index seeks',
  () => {
    let fixture: OrganizationOwnedFixture;
    let closeFixture: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      fixture = await createOrganizationOwnedFixture();
      closeFixture = fixture.close;
    }, 60_000);
    afterAll(async () => {
      await closeFixture?.();
    });

    it('seeks sparse expired and retired state without walking 5000 current bookmarks or future receipts', async () => {
      const scope = await fixture.scope();
      await fixture.transaction(
        fixture.owner,
        scope.workspace,
        scope.actor,
        async (client) => {
          const generation = (
            await client.query<{ generation: string }>(
              `select (app.read_workflow_favorite_generation()->>'generation') generation`,
            )
          ).rows[0]?.generation;
          if (generation === undefined)
            throw new Error('Fixture generation is missing');
          // Privileged dense-state fixture for query plans, not a serving command or
          // unfinished-receipt recovery claim. All identities come from owning SQL.
          await client.query(
            `with workflows as (
        insert into app.workflows(id,workspace_id,name,created_by)
        select uuidv7(),$1,'Dense organization plan fixture',$2 from generate_series(1,5000)
        returning id
      ), favorites as (
        insert into app.workflow_favorites(workspace_id,actor_id,workflow_id,generation,favorite,revision)
        select $1,$2,id,$3,true,uuidv7() from workflows returning workflow_id
      ), private_receipts as (
        insert into app.workflow_favorite_receipts(workspace_id,actor_id,generation,workflow_id,key_hash,request_hash,
          created_at,expires_at)
        select $1,$2,$3,workflow_id,repeat('a',64),repeat('b',64),clock_timestamp(),clock_timestamp()+interval '1 day'
        from favorites returning workflow_id
      ) insert into app.workflow_organization_receipts(workspace_id,actor_id,operation,target_id,key_hash,request_hash,
          created_at,expires_at)
        select $1,$2,'tag.create',workflow_id,repeat('a',64),repeat('b',64),clock_timestamp(),clock_timestamp()+interval '1 day'
        from private_receipts`,
            [scope.workspace, scope.actor, generation],
          );
          await client.query(
            `update app.workflow_favorite_membership_generations set retired_at=clock_timestamp()
        where workspace_id=$1 and actor_id=$2`,
            [scope.workspace, scope.actor],
          );
          await client.query('analyze app.workflow_favorites');
          await client.query('analyze app.workflow_favorite_receipts');
          await client.query('analyze app.workflow_organization_receipts');
          const statements = [
            [
              `select ctid from app.workflow_favorites where workspace_id=$1 and not favorite and expires_at<=$4
          order by expires_at,actor_id,workflow_id limit 1`,
              'expires_at',
            ],
            [
              `select ctid from app.workflow_favorites where workspace_id=$1 and actor_id=$2 and generation<$3
          order by generation,workflow_id limit 1`,
              'generation',
            ],
            [
              `select ctid from app.workflow_favorites where workspace_id=$1 and actor_id=$2 and generation>$3
          order by generation,workflow_id limit 1`,
              'generation',
            ],
            [
              `select ctid from app.workflow_favorite_receipts where workspace_id=$1 and expires_at<=$4
          order by expires_at,actor_id,workflow_id,key_hash limit 1`,
              'expires_at',
            ],
            [
              `select ctid from app.workflow_organization_receipts where workspace_id=$1 and expires_at<=$4
          order by expires_at,actor_id,operation,target_id,key_hash limit 1`,
              'expires_at',
            ],
          ] as const;
          for (const [statement, range] of statements) {
            // Typed parameter CTE preserves the exact seek expression even when a
            // particular stream does not need every parameter; no planner knobs.
            const explained = await client.query<{
              'QUERY PLAN': { Plan: Plan }[];
            }>(
              `explain(analyze,buffers,format json) with parameters as
            (select $1::uuid workspace,$2::uuid actor,$3::uuid generation,$4::timestamptz now)
            ${statement}`,
              [scope.workspace, scope.actor, generation, new Date()],
            );
            const plan = explained.rows[0]?.['QUERY PLAN'][0]?.Plan;
            if (plan === undefined)
              throw new Error('PostgreSQL query plan is missing');
            expect(
              nodes(plan).some((node) => node['Node Type'] === 'Seq Scan'),
            ).toBe(false);
            expect(
              nodes(plan).some((node) => node['Index Cond']?.includes(range)),
            ).toBe(true);
            expect(plan['Actual Rows']).toBe(0);
          }
        },
      );
      const result = (
        await fixture.maintenance.query<Record<string, number>>(
          'select * from app.reap_workflow_organization(1)',
        )
      ).rows[0];
      expect(result).toEqual({
        favorites_deleted: 0,
        evidence_deleted: 0,
        private_receipts_deleted: 0,
        shared_receipts_deleted: 0,
        generations_cleared: 1,
      });
      expect(
        (
          await fixture.owner.query(
            `select count(*)::int count from app.workflow_favorite_receipts
      where workspace_id=$1`,
            [scope.workspace],
          )
        ).rows,
      ).toEqual([{ count: 5000 }]);
    }, 20_000);
  },
);
