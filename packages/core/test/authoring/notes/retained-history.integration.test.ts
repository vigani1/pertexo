import { Pool } from 'pg';
import { adminDatabaseUrl } from '../../support/workflow-authoring/base.js';
import { beforeAll, afterAll, expect, it } from 'vitest';
import {
  actorId,
  authoring,
  emptyGraph,
  workspaceId,
  randomUUID,
  currentRepresentationTag,
  saveCurrentDraft,
  queryAsOwner,
} from '../../support/workflow-authoring.js';

const inspector = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
beforeAll(() =>
  inspector.query('create extension if not exists pg_stat_statements'),
);
afterAll(() => inspector.end());

const noteIds = Array.from({ length: 20 }, () => randomUUID());
const documented = (text: string) => ({
  ...emptyGraph,
  notes: noteIds.map((id) => ({
    id,
    text: text.padEnd(4000, 'x'),
    position: { x: 0, y: 0 },
    size: { width: 320, height: 200 },
    color: 'amber' as const,
  })),
});

it('reuses the most recent matching notes across 500 retained versions and preserves older matches and new notes', async () => {
  const { workflowId } = await authoring.createWorkflow({
    actorId,
    workspaceId,
    emptyGraph,
    name: 'Retained documentation',
    idempotencyKey: randomUUID(),
  });
  const publish = async () => {
    const before = process.memoryUsage();
    const started = performance.now();
    const result = await authoring.publishWorkflow({
      actorId,
      workspaceId,
      workflowId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        { scopedWorkflowId: workflowId, scopedActorId: actorId },
      ),
      idempotencyKey: randomUUID(),
      requestHash: 'a'.repeat(64),
    });
    if (process.env.PERTEXO_HISTORY_BENCHMARK === '1')
      process.stdout.write(
        JSON.stringify({
          history: 500,
          selectedVersion: result.version.versionNumber,
          reused: result.reused,
          elapsedMs: performance.now() - started,
          before,
          after: process.memoryUsage(),
        }) + '\n',
      );
    return result;
  };
  const first = await publish();
  await queryAsOwner(
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
    select uuidv7(),workspace_id,workflow_id,n,$2::json,checksum,executable_json,published_by
    from app.workflow_versions cross join generate_series(2,500) n where id=$1`,
    [first.version.id, JSON.stringify(documented('Repeated documentation'))],
    workspaceId,
  );
  await saveCurrentDraft(authoring, {
    actorId,
    workspaceId,
    workflowId,
    expectedRevision: 1,
    graphJson: documented('Repeated documentation'),
  });
  const latest = await publish();
  expect(latest.reused).toBe(true);
  expect(latest.version.versionNumber).toBe(500);
  await saveCurrentDraft(authoring, {
    actorId,
    workspaceId,
    workflowId,
    expectedRevision: 2,
    graphJson: emptyGraph,
  });
  const older = await publish();
  expect(older.reused).toBe(true);
  expect(older.version.id).toBe(first.version.id);
  await saveCurrentDraft(authoring, {
    actorId,
    workspaceId,
    workflowId,
    expectedRevision: 3,
    graphJson: documented('New documentation'),
  });
  const fresh = await publish();
  expect(fresh.reused).toBe(false);
  expect(fresh.version.versionNumber).toBe(501);
  expect(fresh.version.graphJson.notes).toEqual(
    documented('New documentation').notes,
  );
  expect(
    await queryAsOwner(
      'select count(*)::int count from app.workflow_versions where workflow_id=$1',
      [workflowId],
      workspaceId,
    ),
  ).toEqual([{ count: 501 }]);
  // A decisive newest match must not require decoding unrelated old snapshots.
  await queryAsOwner(
    "update app.workflow_versions set graph_json='{}' where id=$1",
    [first.version.id],
    workspaceId,
  );
  const transferredRows = async () => {
    const result = await inspector.query<{ count: string }>(
      `select coalesce(sum(rows),0)::text count from public.pg_stat_statements
       where dbid=(select oid from pg_database where datname=current_database())
         and query ilike '%workflow_versions%' and query ilike '%graph_json%'`,
    );
    return Number(result.rows[0]?.count);
  };
  const beforeTransfer = await transferredRows();
  const repeated = await publish();
  expect((await transferredRows()) - beforeTransfer).toBeLessThan(50);
  expect(repeated.reused).toBe(true);
  expect(repeated.version.id).toBe(fresh.version.id);
});
