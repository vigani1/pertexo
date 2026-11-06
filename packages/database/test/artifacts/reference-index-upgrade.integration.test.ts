import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { expectedMigrationsAfter } from '../../src/testing/expected-migrations.js';
import { ARTIFACT_OWNER_SOURCES } from '../../src/schema/artifacts/references.js';
import { withUpgradeDatabase } from '../platform/migrations/upgrade-fixture.js';
import { seedReferenceIndexOwners } from './reference-index.fixture.js';

it('backfills every populated owner without changing JSON, normalizes UUIDs, and keeps new writes atomic', async () => {
  await withUpgradeDatabase(109, async ({ admin, upgrade, config }) => {
    const state = await seedReferenceIndexOwners(admin);
    const documents = async () =>
      Promise.all(
        ARTIFACT_OWNER_SOURCES.map(
          async (source) =>
            (
              await admin.query<{ value: unknown }>(
                `select to_jsonb(owner) value from app.${source.table} owner where workspace_id=$1 order by ${source.id}${source.sub ? ',' + source.sub : ''}`,
                [state.workspaceId],
              )
            ).rows,
        ),
      );
    const before = await documents();
    expect(await upgrade(110)).toEqual(['0110_artifact_owner_references.sql']);
    expect(await documents()).toEqual(before);
    const references = () =>
      admin.query<{
        artifact_id: string;
        owner_family: string;
        owner_slot: string;
      }>(
        'select artifact_id,owner_family,owner_slot from app.artifact_owner_references where workspace_id=$1 order by owner_family,owner_id,owner_sub_id,owner_slot',
        [state.workspaceId],
      );
    const rows = (await references()).rows;
    expect(rows).toHaveLength(58);
    expect(new Set(rows.map((row) => row.owner_family))).toEqual(
      new Set(ARTIFACT_OWNER_SOURCES.map((source) => source.table)),
    );
    expect(new Set(rows.map((row) => row.artifact_id))).toEqual(
      new Set([state.artifactId]),
    );
    expect(rows).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifact_id: state.businessId }),
      ]),
    );
    expect(await upgrade(110)).toEqual([]);
    expect((await references()).rows).toEqual(rows);
    expect(await upgrade()).toEqual(await expectedMigrationsAfter(110));
    expect(await documents()).toEqual(before);
    expect((await references()).rows).toEqual(rows);

    await admin.query('begin');
    await admin.query(
      "update app.workflow_drafts set graph_json='{}' where workflow_id=$1",
      [state.workflowId],
    );
    expect((await references()).rows).toHaveLength(57);
    await admin.query('rollback');
    expect((await references()).rows).toEqual(rows);
    await admin.query(
      "update app.workflow_drafts set graph_json='{}' where workflow_id=$1",
      [state.workflowId],
    );
    expect((await references()).rows).toHaveLength(57);
    await admin.query('delete from app.workflow_drafts where workflow_id=$1', [
      state.workflowId,
    ]);
    expect((await references()).rows).toHaveLength(57);
    await admin.query('delete from app.run_events where workflow_run_id=$1', [
      state.runId,
    ]);
    expect((await references()).rows).toHaveLength(56);
    await admin.query(
      'delete from app.workflow_test_suite_cases where suite_id=$1',
      [state.suiteId],
    );
    expect((await references()).rows).toHaveLength(55);
    const scopedUrl = (base: string | undefined) => {
      if (!base) throw new Error('Scoped database URL required');
      const url = new URL(base);
      url.pathname = new URL(config.connectionString).pathname;
      return url.toString();
    };
    const app = new Client({
      connectionString: scopedUrl(process.env.DATABASE_URL),
    });
    const maintenance = new Client({
      connectionString: scopedUrl(process.env.DATABASE_MAINTENANCE_URL),
    });
    await Promise.all([app.connect(), maintenance.connect()]);
    try {
      await app.query("select set_config('app.workspace_id',$1,false)", [
        randomUUID(),
      ]);
      expect(
        (await app.query('select * from app.artifact_owner_references')).rows,
      ).toEqual([]);
      await app.query("select set_config('app.workspace_id',$1,false)", [
        state.workspaceId,
      ]);
      await expect(
        app.query(
          'delete from app.artifact_owner_references where workspace_id=$1',
          [state.workspaceId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      const draft = (
        await app.query<{ workflow_id: string }>(
          'select workflow_id from app.workflow_drafts where workspace_id=$1 limit 1',
          [state.workspaceId],
        )
      ).rows[0];
      if (!draft) throw new Error('Retained draft missing');
      await app.query('begin');
      try {
        await app.query(
          "update app.workflow_drafts set graph_json='{}' where workflow_id=$1",
          [draft.workflow_id],
        );
        expect(
          (
            await app.query<{ count: number }>(
              'select count(*)::int count from app.artifact_owner_references',
            )
          ).rows,
        ).toEqual([{ count: 54 }]);
        expect(
          (
            await app.query<{ scope: string }>(
              "select current_setting('app.workspace_id') scope",
            )
          ).rows,
        ).toEqual([{ scope: state.workspaceId }]);
      } finally {
        await app.query('rollback');
      }
      const maintenanceScope = randomUUID();
      await maintenance.query(
        "select set_config('app.workspace_id',$1,false)",
        [maintenanceScope],
      );
      await maintenance.query('begin');
      try {
        await maintenance.query(
          'delete from app.workflow_drafts where workflow_id=$1',
          [draft.workflow_id],
        );
        expect(
          (
            await maintenance.query<{ count: number }>(
              'select count(*)::int count from app.artifact_owner_references',
            )
          ).rows,
        ).toEqual([{ count: 54 }]);
        expect(
          (
            await maintenance.query<{ scope: string }>(
              "select current_setting('app.workspace_id') scope",
            )
          ).rows,
        ).toEqual([{ scope: maintenanceScope }]);
      } finally {
        await maintenance.query('rollback');
      }
      expect((await references()).rows).toHaveLength(55);
    } finally {
      await Promise.all([app.end(), maintenance.end()]);
    }
    const truncation = await admin.connect();
    try {
      await truncation.query('begin');
      await truncation.query('truncate app.workflow_drafts');
      expect(
        (
          await truncation.query<{ count: number }>(
            'select count(*)::int count from app.artifact_owner_references',
          )
        ).rows,
      ).toEqual([{ count: 15 }]);
      await truncation.query('rollback');
    } finally {
      truncation.release();
    }
    expect((await references()).rows).toHaveLength(55);
    const flags = await admin.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      'select relrowsecurity,relforcerowsecurity from pg_class where oid=any($1::regclass[])',
      [
        ARTIFACT_OWNER_SOURCES.map((source) => 'app.' + source.table).concat(
          'app.artifact_owner_references',
        ),
      ],
    );
    expect(flags.rows).toHaveLength(14);
    expect(
      flags.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
    ).toBe(true);
  });
}, 60_000);
