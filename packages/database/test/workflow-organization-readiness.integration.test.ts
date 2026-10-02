import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDatabaseReadiness } from '../src/platform/readiness.js';
import { READINESS_WORKFLOW_ORGANIZATION_SQL } from '../src/platform/readiness-workflow-organization.sql.js';
import {
  createOrganizationOwnedFixture,
  organizationFixtureEnabled,
  type OrganizationOwnedFixture,
} from './support/workflow-organization-owned.fixture.js';

const roles = [
  'pertexo_owner',
  'pertexo_worker',
  'pertexo_api',
  'pertexo_maintenance',
];
const query = `select ${READINESS_WORKFLOW_ORGANIZATION_SQL} compatible`;

describe.skipIf(!organizationFixtureEnabled)(
  'owned F07 exact readiness inventory',
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

    it('accepts the exact installed default-off schema through real API startup readiness', async () => {
      expect(await checkDatabaseReadiness(fixture.api)).toMatchObject({
        migrationHead: '0134_workflow_organization.sql',
        role: 'pertexo_api',
        postgresMajor: 18,
      });
      expect((await fixture.api.query(query, roles)).rows).toEqual([
        { compatible: true },
      ]);
    });

    it('does not use the independently mutable writer flag as schema readiness', async () => {
      const client = await fixture.owner.connect();
      try {
        await client.query('begin');
        await client.query('set local role pertexo_owner');
        await client.query(
          'update app.workflow_organization_rollout set writes_enabled=true',
        );
        expect((await client.query(query, roles)).rows).toEqual([
          { compatible: true },
        ]);
      } finally {
        await client.query('rollback');
        client.release();
      }
    });

    it('rejects a changed helper return ABI even with identical body and privileges', async () => {
      const client = await fixture.owner.connect();
      try {
        await client.query('begin');
        await client.query('set local role pertexo_owner');
        const original = (
          await client.query<{ definition: string; hash: string }>(
            `select pg_get_functiondef(oid) definition,md5(prosrc) hash from pg_proc
           where oid='app.workflow_favorite_command_body(jsonb)'::regprocedure`,
          )
        ).rows[0];
        if (original === undefined)
          throw new Error('Required helper is missing');
        const changed = original.definition.replace(
          'RETURNS jsonb',
          'RETURNS text',
        );
        expect(changed).not.toBe(original.definition);
        await client.query(
          'drop function app.workflow_favorite_command_body(jsonb)',
        );
        await client.query(changed);
        await client.query(
          'revoke all on function app.workflow_favorite_command_body(jsonb) from public',
        );
        expect(
          (
            await client.query(`select md5(prosrc) hash from pg_proc
          where oid='app.workflow_favorite_command_body(jsonb)'::regprocedure`)
          ).rows,
        ).toEqual([{ hash: original.hash }]);
        expect((await client.query(query, roles)).rows).toEqual([
          { compatible: false },
        ]);
      } finally {
        await client.query('rollback');
        client.release();
      }
    });

    it.each([
      ['missing table', 'drop table app.workflow_favorite_held_evidence'],
      [
        'extra column',
        'alter table app.workflow_tags add column unexpected text',
      ],
      [
        'changed nullability',
        'alter table app.workflow_tags alter column key drop not null',
      ],
      [
        'changed default',
        'alter table app.workflow_tags alter column revision set default 2',
      ],
      [
        'missing check',
        'alter table app.workflow_tags drop constraint workflow_tags_key_check',
      ],
      ['missing index', 'drop index app.workflow_tag_assignments_tag_idx'],
      [
        'extra index',
        'create index unexpected_f07_index on app.workflow_tags(id)',
      ],
      [
        'disabled RLS',
        'alter table app.workflow_favorites disable row level security',
      ],
      [
        'unforced RLS',
        'alter table app.workflow_favorites no force row level security',
      ],
      [
        'weakened policy',
        'alter policy workflow_favorites_actor on app.workflow_favorites using(true)',
      ],
      [
        'extra policy',
        'create policy unexpected_f07_policy on app.workflow_favorites to pertexo_api using(true)',
      ],
      [
        'private read grant',
        'grant select on app.workflow_favorite_held_evidence to pertexo_api',
      ],
      [
        'shared write grant',
        'grant update on app.workflow_tags to pertexo_api',
      ],
      [
        'worker read grant',
        'grant select on app.workflow_tags to pertexo_worker',
      ],
      ['public read grant', 'grant select on app.workflow_tags to public'],
      ['column grant', 'grant update(key) on app.workflow_tags to pertexo_api'],
      [
        'missing API helper grant',
        'revoke execute on function app.read_workflow_favorite_generation() from pertexo_api',
      ],
      [
        'private helper exposure',
        'grant execute on function app.lock_workflow_favorite_generation(boolean) to pertexo_api',
      ],
      [
        'maintenance exposure',
        'grant execute on function app.reap_workflow_organization(integer) to pertexo_worker',
      ],
      [
        'definer weakened',
        'alter function app.execute_workflow_tag_command(text,uuid,text,jsonb) security invoker',
      ],
      [
        'search path changed',
        'alter function app.execute_workflow_tag_command(text,uuid,text,jsonb) set search_path=app,public',
      ],
      [
        'row security changed',
        'alter function app.execute_workflow_tag_command(text,uuid,text,jsonb) set row_security=off',
      ],
      [
        'volatility changed',
        'alter function app.execute_workflow_tag_command(text,uuid,text,jsonb) stable',
      ],
      [
        'strictness changed',
        'alter function app.execute_workflow_tag_command(text,uuid,text,jsonb) strict',
      ],
      [
        'disabled departure trigger',
        'alter table app.workspace_memberships disable trigger workflow_favorite_membership_departure',
      ],
      [
        'missing departure trigger',
        'drop trigger workflow_favorite_membership_departure on app.workspace_memberships',
      ],
    ])(
      'rejects %s without changing the independent writer',
      async (_label, mutation) => {
        const client = await fixture.owner.connect();
        try {
          await client.query('begin');
          await client.query('set local role pertexo_owner');
          await client.query(mutation);
          expect((await client.query(query, roles)).rows).toEqual([
            { compatible: false },
          ]);
        } finally {
          await client.query('rollback');
          client.release();
        }
        expect((await fixture.api.query(query, roles)).rows).toEqual([
          { compatible: true },
        ]);
      },
    );
  },
);
