import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { acceptWorkflowRun } from '../src/runs/commands/acceptance.js';
import { workflowRuns } from '../src/schema.js';
import {
  acceptanceInput,
  apiDatabase,
  installExecutionAcceptanceFixture,
  migrationUrl,
  workflowId,
  workflowVersionId,
  workerDatabase,
  workspaceA,
  workspaceCreatorId,
  lockManualFixtureStart,
} from './execution-acceptance.fixtures.js';

installExecutionAcceptanceFixture();

async function publishDuration(maxRunDurationMs?: number): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceA,
    ]);
    await client.query(
      `insert into app.workflows(id,workspace_id,name,created_by)
       values ($1,$2,'Duration regression',$3)`,
      [workflowId, workspaceA, workspaceCreatorId],
    );
    await client.query(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,
        version_number,schema_version,graph_json,checksum,published_by,
        executable_schema_version,executable_json,compatibility_release_epoch)
       values ($1,$2,$3,1,1,$4::jsonb,$5,$6,2,
         jsonb_build_object('schemaVersion',2,'graph',$4::jsonb),1)`,
      [
        workflowVersionId,
        workspaceA,
        workflowId,
        JSON.stringify({
          schemaVersion: 1,
          nodes: [],
          edges: [],
          settings: { maxRunDurationMs },
        }),
        `wf:v2:sha256:${'a'.repeat(64)}`,
        workspaceCreatorId,
      ],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function persistedDeadline(
  runId: string,
): Promise<Date | null | undefined> {
  return apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
    const [row] = await db
      .select({ deadline: workflowRuns.deadlineAt })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId));
    return row?.deadline;
  });
}

describe('published workflow duration at run acceptance', () => {
  it.each(['manual', 'api', 'schedule', 'webhook'] as const)(
    'pins the saved duration for %s and preserves the deadline on duplicate acceptance',
    async (triggerType) => {
      await publishDuration(5_000);
      const input = { ...acceptanceInput(), triggerType };
      const database =
        triggerType === 'schedule' ? workerDatabase : apiDatabase;
      const first = await database.withWorkspace(
        workspaceA,
        async (transaction) => {
          if (triggerType === 'manual')
            await lockManualFixtureStart(transaction);
          return acceptWorkflowRun(transaction, input);
        },
      );
      const expected = new Date(first.acceptedAt.getTime() + 5_000);
      expect(await persistedDeadline(first.runId)).toEqual(expected);
      const duplicate = await database.withWorkspace(
        workspaceA,
        async (transaction) => {
          if (triggerType === 'manual')
            await lockManualFixtureStart(transaction);
          return acceptWorkflowRun(transaction, input);
        },
      );
      expect(duplicate).toMatchObject({ runId: first.runId, duplicate: true });
      expect(await persistedDeadline(first.runId)).toEqual(expected);
    },
  );

  it.each(['earlier', 'later'] as const)(
    'uses the stricter deadline when the caller deadline is %s',
    async (timing) => {
      await publishDuration(5_000);
      const deadlineAt = new Date(
        Date.now() + (timing === 'earlier' ? 1_000 : 60_000),
      );
      const run = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, { ...acceptanceInput(), deadlineAt }),
      );
      expect(await persistedDeadline(run.runId)).toEqual(
        timing === 'earlier'
          ? deadlineAt
          : new Date(run.acceptedAt.getTime() + 5_000),
      );
    },
  );

  it.each([true, false])(
    'preserves optional explicit deadline without a saved limit (%s)',
    async (explicit) => {
      await publishDuration();
      const deadlineAt = explicit ? new Date(Date.now() + 60_000) : undefined;
      const run = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, {
          ...acceptanceInput(),
          ...(deadlineAt === undefined ? {} : { deadlineAt }),
        }),
      );
      expect(await persistedDeadline(run.runId)).toEqual(deadlineAt ?? null);
    },
  );
});
