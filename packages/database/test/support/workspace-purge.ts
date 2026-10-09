import { Client } from 'pg';

import { parseDatabaseConfig } from '../../src/config.js';
import { createWorkspacePurgeCoordinator } from '../../src/lifecycle/workspace-purge.js';
import type { WorkspacePurgeObjectStore } from '../../src/lifecycle/workspace-purge.js';

/** An object store with nothing in it. */
export const emptyObjectStore: WorkspacePurgeObjectStore = Object.freeze({
  purgeWorkspacePage: () =>
    Promise.resolve({ completed: true, deletedCount: 0 }),
});

/**
 * Marks a workspace deleted past its recovery period, as an admin would
 * see it after the request, so the next purge pass picks it up.
 */
export async function makeWorkspaceDueForPurge(
  adminUrl: string,
  workspaceId: string,
): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      `update app.workspaces
       set status = 'pending_deletion',
           deletion_requested_at = clock_timestamp() - interval '31 days',
           deletion_requested_by = created_by,
           deletion_reason = 'Purge test',
           purge_after = clock_timestamp() - interval '1 day'
       where id = $1`,
      [workspaceId],
    );
  } finally {
    await admin.end();
  }
}

/**
 * Purges one workspace to completion through the maintenance role and
 * returns the step of every page, in order.
 */
export async function purgeWorkspace(
  input: Readonly<{
    adminUrl: string;
    maintenanceUrl: string;
    workspaceId: string;
    objectStore?: WorkspacePurgeObjectStore;
    pageSize?: number;
    afterPage?: (step: string) => Promise<void>;
  }>,
): Promise<readonly string[]> {
  await makeWorkspaceDueForPurge(input.adminUrl, input.workspaceId);
  const coordinator = createWorkspacePurgeCoordinator(
    parseDatabaseConfig({ connectionString: input.maintenanceUrl, max: 2 }),
    input.objectStore ?? emptyObjectStore,
    input.pageSize === undefined ? {} : { pageSize: input.pageSize },
  );
  const steps: string[] = [];
  try {
    for (let call = 0; call < 10_000; call += 1) {
      const result = await coordinator.processNext();
      if (result.status === 'idle') break;
      if (result.workspaceId !== input.workspaceId) continue;
      if (result.status === 'completed') return steps;
      if (result.status === 'progressed') {
        steps.push(result.step);
        await input.afterPage?.(result.step);
      }
    }
    throw new Error(`Workspace ${input.workspaceId} was not purged`);
  } finally {
    await coordinator.close();
  }
}
