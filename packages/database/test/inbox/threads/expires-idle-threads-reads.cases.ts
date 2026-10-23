import { expect, it } from 'vitest';

import { enforceRetention } from '../../support/retention.js';
import { purgeWorkspace } from '../../support/workspace-purge.js';
import {
  adminUrl,
  fixture,
  maintenanceUrl,
  inbox,
  threadId,
  asAdmin,
  seed,
  fail,
  threads,
  drain,
  reader,
} from './fixture.js';

export function registerExpiresIdleThreadsReads(): void {
  it('expires idle threads with their reads', async () => {
    const idle = await seed();
    await fail(idle.workspaceId, idle.first);
    await drain();
    const owner = reader(idle.workspaceId, idle.members.owner);
    const { revision } = await inbox.readSummary(owner);
    await inbox.markThreadRead({
      ...owner,
      threadId: await threadId(idle.workspaceId, idle.first),
      revision,
    });
    await asAdmin(
      `update app.workspace_inbox_threads
          set first_occurred_at=now()-interval '31 days',
              latest_occurred_at=now()-interval '31 days'
        where workspace_id=$1`,
      [idle.workspaceId],
    );
    await enforceRetention(maintenanceUrl);
    await expect(threads(idle.workspaceId)).resolves.toEqual([]);
    await expect(
      asAdmin('select 1 from app.workspace_inbox_reads where workspace_id=$1', [
        idle.workspaceId,
      ]),
    ).resolves.toEqual([]);
  });

  it('is erased by the workspace purge before its parents', async () => {
    const { workspaceId, first, members } = await seed();
    const other = await seed();
    for (const target of [
      { workspaceId, workflowId: first },
      { workspaceId: other.workspaceId, workflowId: other.first },
    ])
      await fail(target.workspaceId, target.workflowId);
    await drain();
    await inbox.markAllRead({
      ...reader(workspaceId, members.owner),
      revision: (await inbox.readSummary(reader(workspaceId, members.owner)))
        .revision,
    });
    // A failure recorded after the last fold is still pending at purge time.
    await fail(workspaceId, first);
    const counts = async (target: string) =>
      asAdmin<{ events: number; threads: number; reads: number }>(
        `select
           (select count(*)::int from app.workspace_inbox_events where workspace_id=$1) events,
           (select count(*)::int from app.workspace_inbox_threads where workspace_id=$1) threads,
           (select count(*)::int from app.workspace_inbox_reads where workspace_id=$1) reads`,
        [target],
      );
    await expect(counts(workspaceId)).resolves.toEqual([
      { events: 1, threads: 1, reads: 1 },
    ]);

    const steps = await purgeWorkspace({
      adminUrl: fixture.databaseUrl(adminUrl),
      maintenanceUrl,
      workspaceId,
      pageSize: 1,
    });
    const erased = [
      ...new Set(steps.filter((step) => step.startsWith('workspace_inbox_'))),
    ];
    expect(erased).toEqual([
      'workspace_inbox_reads',
      'workspace_inbox_threads',
      'workspace_inbox_events',
    ]);
    await expect(counts(workspaceId)).resolves.toEqual([
      { events: 0, threads: 0, reads: 0 },
    ]);
    await expect(counts(other.workspaceId)).resolves.toEqual([
      { events: 0, threads: 1, reads: 0 },
    ]);
  });
}
