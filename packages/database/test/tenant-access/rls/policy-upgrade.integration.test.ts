import { expect, it } from 'vitest';

import {
  seedWorkflow,
  withUpgradeDatabase,
} from '../../platform/migrations/upgrade-fixture.js';
import {
  policyDrops,
  policyMatrix,
  securityCatalog,
  workspaces,
} from './policy-matrix.js';

it('preserves role, operation and workspace access for all twelve retired policies on a populated upgrade', async () => {
  await withUpgradeDatabase(83, async ({ admin, upgrade }) => {
    const { workflowId } = await seedWorkflow(admin);
    const beforeRow = (
      await admin.query(
        'select to_jsonb(w) row from app.workflows w where id=$1',
        [workflowId],
      )
    ).rows;
    const before = await policyMatrix(admin);
    const security = await securityCatalog(admin);
    const policies = async () =>
      (
        await admin.query<{ policyname: string }>(
          "select policyname from pg_policies where schemaname='app'",
        )
      ).rows.map((row) => row.policyname);
    const installed = await policies();
    for (const [, policy] of policyDrops) expect(installed).toContain(policy);
    expect(before).toHaveLength(810);
    // Non-vacuous controls: real workspace predicates must both show and hide rows.
    expect(
      before.find(
        (row) =>
          row.table === 'workflows' &&
          row.role === 'pertexo_app' &&
          row.context === '' &&
          row.operation === 'select',
      )?.output,
    ).toEqual([]);
    expect(
      before.find(
        (row) =>
          row.table === 'workflows' &&
          row.role === 'pertexo_app' &&
          row.context === workspaces[0] &&
          row.operation === 'select',
      )?.output,
    ).toHaveLength(12);

    expect(await upgrade(84)).toEqual([
      '0084_remove_redundant_rls_policies.sql',
    ]);
    const after = await policyMatrix(admin);
    const remaining = await policies();
    for (const [table, policy] of policyDrops) {
      expect(remaining, policy).not.toContain(policy);
      expect(
        after.filter((row) => row.table === table),
        policy,
      ).toEqual(before.filter((row) => row.table === table));
    }
    expect(await securityCatalog(admin)).toEqual(security);
    expect(
      (
        await admin.query(
          'select to_jsonb(w) row from app.workflows w where id=$1',
          [workflowId],
        )
      ).rows,
    ).toEqual(beforeRow);
  });
}, 120_000);
