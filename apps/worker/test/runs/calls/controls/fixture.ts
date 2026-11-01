import { createWorkflowRunDatabase } from '@pertexo/core/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { afterAll, beforeAll, expect } from 'vitest';
import type { runtime } from '../fixtures.js';
import { fixture } from '../fixtures.js';

export function createCallControlsFixture() {
  beforeAll(fixture.setup, 60_000);

  afterAll(fixture.restoreServicesAndClose);

  const runs = createWorkflowRunDatabase(
    parseDatabaseConfig({
      connectionString: fixture.databaseUrl(fixture.apiUrl),
      max: 2,
    }),
  );

  afterAll(() => runs.close());

  async function activeChild(
    workers: Awaited<ReturnType<typeof runtime>>,
    parentRunId: string,
  ) {
    let childId = '';
    await workers.until(async () => {
      const rows = await fixture.workerQuery<{
        child_run_id: string;
        status: string;
        slot_lent: boolean;
      }>(
        'select call.child_run_id,child.status,call.slot_lent from app.workflow_calls call join app.workflow_runs child on child.id=call.child_run_id and child.workspace_id=call.workspace_id where call.parent_run_id=$1',
        [parentRunId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('waiting');
      expect(rows[0]?.slot_lent).toBe(true);
      childId = rows[0]?.child_run_id ?? '';
    });
    return childId;
  }

  async function settled(
    workers: Awaited<ReturnType<typeof runtime>>,
    runId: string,
    status: string,
    readerId = fixture.actorId,
  ) {
    await workers.until(async () => {
      expect(
        (
          await runs.get({
            actorId: readerId,
            workspaceId: fixture.workspaceId,
            runId,
          })
        )?.run.status,
      ).toBe(status);
    });
  }

  async function noLoans() {
    expect(
      await fixture.workerQuery(
        'select count(*)::int count from app.workflow_calls where workspace_id=$1 and slot_lent',
        [fixture.workspaceId],
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await fixture.workerQuery(
        'select workflow_run_id from app.workflow_run_active_admissions where workspace_id=$1',
        [fixture.workspaceId],
      ),
    ).toEqual([]);
  }
  return { activeChild, runs, settled, noLoans };
}
