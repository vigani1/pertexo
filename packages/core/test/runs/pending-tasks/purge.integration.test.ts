import { expect, it } from 'vitest';
import { createWorkspacePurgeCoordinator } from '../../../src/lifecycle/purge/coordinator.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { maintenanceUrl } from '../../lifecycle/retention.support.js';
import { admin, taskFixture } from './fixtures.js';
it('deletes pending human tasks with their workspace through the maintenance role', async () => {
  const f = await taskFixture();
  await admin.query(
    "update app.workspaces set status='purging',deletion_requested_at=clock_timestamp()-interval '2 days',deletion_requested_by=created_by,deletion_reason='Owned approval qualification',purge_after=clock_timestamp()-interval '1 day' where id=$1",
    [f.workspaceId],
  );
  const purge = createWorkspacePurgeCoordinator(
    parseDatabaseConfig({ connectionString: maintenanceUrl, max: 1 }),
    {
      purgeWorkspacePage: () =>
        Promise.resolve({ completed: true, deletedCount: 0 }),
    },
    { pageSize: 2 },
  );
  try {
    let completed = false;
    for (let page = 0; page < 100 && !completed; page++) {
      const result = await purge.processNext();
      completed =
        result.status === 'completed' && result.workspaceId === f.workspaceId;
    }
    expect(completed).toBe(true);
    expect(
      (
        await admin.query(
          'select id from app.pending_run_tasks where workspace_id=$1',
          [f.workspaceId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await admin.query('select status from app.workspaces where id=$1', [
          f.workspaceId,
        ])
      ).rows,
    ).toEqual([{ status: 'deleted' }]);
  } finally {
    await purge.close();
  }
});
