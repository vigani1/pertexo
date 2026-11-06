import { readFile } from 'node:fs/promises';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  composeExecutableCatalog,
  verifyWorkflowExecutable,
} from '@pertexo/workflow-engine/server';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { expectedMigrationsAfter } from '../../../src/testing/expected-migrations.js';
import { seedWorkflow, withUpgradeDatabase } from './upgrade-fixture.js';

it('preserves legacy versions on upgrade and admits only legacy or v2 executable identities', async () => {
  await withUpgradeDatabase(113, async ({ admin, upgrade }) => {
    const { workspaceId, workflowId, ownerId } = await seedWorkflow(admin);
    const fixture = JSON.parse(
      await readFile(
        new URL(
          '../../../../core/test/fixtures/legacy-workflow-executable.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { checksum: string; envelope: unknown };
    const legacy = fixture.checksum;
    const insert = (checksum: string, version: number) =>
      admin.query(
        `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
       values($1,$2,$3,$4,'{"settings":{},"nodes":[],"edges":[]}',$5,$7::json,$6) returning checksum`,
        [
          randomUUID(),
          workspaceId,
          workflowId,
          version,
          checksum,
          ownerId,
          JSON.stringify(fixture.envelope),
        ],
      );
    await insert(legacy, 1);
    expect(await upgrade()).toEqual(await expectedMigrationsAfter(113));
    expect(
      (
        await admin.query(
          'select checksum from app.workflow_versions where workflow_id=$1',
          [workflowId],
        )
      ).rows,
    ).toEqual([{ checksum: legacy }]);
    const retained = (
      await admin.query(
        'select checksum,executable_json from app.workflow_versions where workflow_id=$1',
        [workflowId],
      )
    ).rows[0] as { checksum: string; executable_json: unknown };
    expect(
      verifyWorkflowExecutable({
        envelope: retained.executable_json,
        checksum: retained.checksum,
        catalog: composeExecutableCatalog(CORE_NODE_CATALOG),
      }).checksum,
    ).toBe(legacy);
    const tagged = legacy.replace('wf:sha256:', 'wf:sha256:v2:');
    expect((await insert(tagged, 2)).rows).toEqual([{ checksum: tagged }]);
    for (const bad of [
      `wf:sha256:v3:${'a'.repeat(64)}`,
      `wf:sha256:v2:${'a'.repeat(63)}`,
      `${legacy}x`,
      'a'.repeat(64),
    ])
      await expect(insert(bad, 3)).rejects.toMatchObject({ code: '23514' });
  });
});

it.each(['call', 'input-case'] as const)(
  'widens an existing %s checksum reference without imposing a new format restriction',
  async (kind) => {
    await withUpgradeDatabase(113, async ({ admin, upgrade }) => {
      const { workspaceId, workflowId, ownerId } = await seedWorkflow(admin);
      const versionId = randomUUID();
      const rowId = randomUUID();
      const retained = 'pre-versioning-reference';
      await admin.query(
        `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
         values($1,$2,$3,1,'{}',$4,'{}',$5)`,
        [
          versionId,
          workspaceId,
          workflowId,
          `wf:sha256:${'a'.repeat(64)}`,
          ownerId,
        ],
      );
      if (kind === 'call') {
        const runId = randomUUID();
        const session = await admin.connect();
        try {
          await session.query('begin');
          await session.query("select set_config('app.workspace_id',$1,true)", [
            workspaceId,
          ]);
          await session.query(
            `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,status,trigger_type)
             values($1,$2,$3,$4,'succeeded','api')`,
            [runId, workspaceId, workflowId, versionId],
          );
          await session.query('commit');
        } catch (error) {
          await session.query('rollback');
          throw error;
        } finally {
          session.release();
        }
        await admin.query(
          `insert into app.workflow_calls(id,workspace_id,parent_run_id,invocation_key,target_workflow_id,target_version_id,target_checksum,input_checksum,status)
           values($1,$2,$3,'retained-call',$4,$5,$6,$7,'pending')`,
          [
            rowId,
            workspaceId,
            runId,
            workflowId,
            versionId,
            retained,
            'a'.repeat(64),
          ],
        );
      } else {
        await admin.query(
          `insert into app.workflow_input_cases(id,workspace_id,workflow_id,workflow_version_id,version_checksum,name)
           values($1,$2,$3,$4,$5,'Retained case')`,
          [rowId, workspaceId, workflowId, versionId, retained],
        );
      }
      const readSql =
        kind === 'call'
          ? 'select target_checksum as checksum from app.workflow_calls where id=$1'
          : 'select version_checksum as checksum from app.workflow_input_cases where id=$1';
      expect((await admin.query(readSql, [rowId])).rows).toEqual([
        { checksum: retained },
      ]);
      expect(await upgrade()).toEqual(await expectedMigrationsAfter(113));
      expect((await admin.query(readSql, [rowId])).rows).toEqual([
        { checksum: retained },
      ]);
      const tagged = `wf:sha256:v2:${'b'.repeat(64)}`;
      const updateSql =
        kind === 'call'
          ? 'update app.workflow_calls set target_checksum=$2 where id=$1'
          : 'update app.workflow_input_cases set version_checksum=$2 where id=$1';
      await admin.query(updateSql, [rowId, tagged]);
      expect((await admin.query(readSql, [rowId])).rows).toEqual([
        { checksum: tagged },
      ]);
    });
  },
);
