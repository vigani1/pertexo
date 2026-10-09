import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganizationOwnedFixture,
  organizationFixtureEnabled,
  type OrganizationOwnedFixture,
} from './support/workflow-organization-owned.fixture.js';
import { enforceRetention } from './support/retention.js';

describe.skipIf(!organizationFixtureEnabled)(
  'owned F07 organization retention at scale',
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

    it('clears a retired membership without touching 5000 current favorites or future receipts', async () => {
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
          // Privileged dense-state fixture, not a serving command. All
          // identities come from owning SQL.
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
        },
      );
      const removed = await enforceRetention(fixture.urls.maintenance);
      expect(removed).toMatchObject({
        earlier_membership_favorites: 0,
        favorite_memberships: 1,
        favorite_receipts: 0,
        organization_receipts: 0,
        unfavorited_workflows: 0,
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
