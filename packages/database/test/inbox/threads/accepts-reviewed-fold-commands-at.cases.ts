import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

import {
  apiUrl,
  fold,
  inbox,
  asAdmin,
  workflow,
  seed,
  fail,
  threads,
  pending,
  drain,
  reader,
} from './fixture.js';

export function registerAcceptsReviewedFoldCommandsAt(): void {
  it('accepts the reviewed fold commands at startup', async () => {
    await expect(fold.checkReadiness()).resolves.toBeUndefined();
  });

  it('records a failure once, only as the worker in its own workspace', async () => {
    const { workspaceId, first } = await seed();
    const runId = await fail(workspaceId, first);
    await fail(workspaceId, first, { runId });
    expect(await pending(workspaceId)).toBe(1);
    await fail(workspaceId, first, { cancellationRequested: true });
    expect(await pending(workspaceId)).toBe(1);

    const other = await seed();
    await expect(
      fail(workspaceId, first, { contextWorkspaceId: other.workspaceId }),
    ).rejects.toMatchObject({ code: '42501' });
    const api = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      await expect(
        api.query(
          `insert into app.workspace_inbox_events
             (id,workspace_id,workflow_id,run_id,terminal_event_sequence,kind,occurred_at)
           values ($1,$2,$3,$4,1,'failed',now())`,
          [randomUUID(), workspaceId, first, runId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await api.end();
    }
  });

  it('folds failures into one thread per workflow and consumes them', async () => {
    const { workspaceId, first, second } = await seed();
    const now = Date.now();
    await fail(workspaceId, first, {
      occurredAt: new Date(now - 3_000).toISOString(),
    });
    const latestRun = await fail(workspaceId, first, {
      kind: 'timed_out',
      occurredAt: new Date(now - 1_000).toISOString(),
    });
    await fail(workspaceId, first, {
      occurredAt: new Date(now - 2_000).toISOString(),
    });
    await fail(workspaceId, second, { kind: 'outcome_unknown' });

    const changes = await fold.foldPending(1_000);
    const change = changes.find((item) => item.workspaceId === workspaceId);
    expect(change?.revision).toMatch(/^[1-9]\d*$/u);
    expect(await pending(workspaceId)).toBe(0);
    const [byFirst, bySecond] = [first, second].map((id) =>
      threads(workspaceId).then((rows) =>
        rows.find((row) => row.workflow_id === id),
      ),
    );
    await expect(byFirst).resolves.toMatchObject({
      occurrence_count: '3',
      latest_kind: 'timed_out',
      latest_run_id: latestRun,
    });
    await expect(bySecond).resolves.toMatchObject({
      occurrence_count: '1',
      latest_kind: 'outcome_unknown',
    });

    const before = (await threads(workspaceId)).find(
      (row) => row.workflow_id === first,
    );
    await fail(workspaceId, first);
    await drain();
    const after = (await threads(workspaceId)).find(
      (row) => row.workflow_id === first,
    );
    expect(after?.occurrence_count).toBe('4');
    expect(BigInt(after?.revision ?? '0')).toBeGreaterThan(
      BigInt(before?.revision ?? '0'),
    );
  });

  it('never counts a failure twice across concurrent folds', async () => {
    const { workspaceId, first, second, members } = await seed();
    const third = await workflow(workspaceId, members.owner);
    const workflows = [first, second, third];
    for (let index = 0; index < 90; index += 1)
      await fail(workspaceId, workflows[index % 3] ?? first);
    for (
      let round = 0;
      round < 20 && (await pending(workspaceId)) !== 0;
      round += 1
    )
      await Promise.all(Array.from({ length: 4 }, () => fold.foldPending(7)));
    expect(await pending(workspaceId)).toBe(0);
    const counts = (await threads(workspaceId)).map((row) =>
      Number(row.occurrence_count),
    );
    expect(counts).toEqual([30, 30, 30]);
  });

  it('starts a thread over once it has been idle for 30 days', async () => {
    const { workspaceId, first } = await seed();
    await fail(workspaceId, first);
    await fail(workspaceId, first);
    await drain();
    await asAdmin(
      `update app.workspace_inbox_threads
          set first_occurred_at=now()-interval '40 days',
              latest_occurred_at=now()-interval '31 days'
        where workspace_id=$1`,
      [workspaceId],
    );
    await fail(workspaceId, first);
    await drain();
    const [thread] = await threads(workspaceId);
    expect(thread?.occurrence_count).toBe('1');
  });

  it('consumes failures of a workspace being purged without a thread', async () => {
    const { workspaceId, first, members } = await seed();
    await fail(workspaceId, first);
    await asAdmin(
      `update app.workspaces
          set status='purging',deletion_requested_at=now()-interval '31 days',
              deletion_requested_by=$2,deletion_reason='Inbox purge',
              purge_after=now()-interval '1 day'
        where id=$1`,
      [workspaceId, members.owner],
    );
    await drain();
    expect(await pending(workspaceId)).toBe(0);
    await expect(threads(workspaceId)).resolves.toEqual([]);
  });

  it('shows threads only to eligible readers of a workspace that can be browsed', async () => {
    const { workspaceId, first, members } = await seed();
    const other = await seed();
    await fail(workspaceId, first);
    await fail(other.workspaceId, other.first);
    await drain();
    const visible = async (actorId: string, workspace = workspaceId) =>
      (
        await inbox.listThreads({
          ...reader(workspace, actorId),
          filter: 'all',
          limit: 10,
        })
      ).items.map((item) => item.workflowId);

    for (const role of ['owner', 'admin', 'operator'] as const)
      await expect(visible(members[role])).resolves.toEqual([first]);
    for (const role of ['builder', 'viewer'] as const)
      await expect(visible(members[role])).resolves.toEqual([]);
    await expect(visible(members.owner, other.workspaceId)).resolves.toEqual(
      [],
    );

    await asAdmin(
      "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
      [workspaceId, members.operator],
    );
    await expect(visible(members.operator)).resolves.toEqual([]);
    await asAdmin("update app.users set status='suspended' where id=$1", [
      members.admin,
    ]);
    await expect(visible(members.admin)).resolves.toEqual([]);
    // A suspended workspace reads but does not change (ADR 013/027).
    await asAdmin("update app.workspaces set status='suspended' where id=$1", [
      workspaceId,
    ]);
    await expect(visible(members.owner)).resolves.toHaveLength(1);
    await asAdmin(
      `update app.workspaces set status='pending_deletion',
         deletion_requested_at=clock_timestamp(),
         deletion_requested_by=created_by, deletion_reason='Closing',
         purge_after=clock_timestamp()+interval '30 days'
       where id=$1`,
      [workspaceId],
    );
    await expect(visible(members.owner)).resolves.toEqual([]);
  });

  it('hides a thread from readers once its latest failure is 30 days old', async () => {
    const { workspaceId, first, members } = await seed();
    await fail(workspaceId, first);
    await drain();
    await asAdmin(
      `update app.workspace_inbox_threads
          set first_occurred_at=now()-interval '31 days',
              latest_occurred_at=now()-interval '31 days'
        where workspace_id=$1`,
      [workspaceId],
    );
    await expect(
      inbox.readSummary(reader(workspaceId, members.owner)),
    ).resolves.toMatchObject({ unreadCount: 0 });
  });
}
