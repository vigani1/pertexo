import { readFile } from 'node:fs/promises';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  composeExecutableCatalog,
  verifyWorkflowExecutable,
} from '@pertexo/workflow-engine';
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
