import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkflowNotFoundError } from '../../../src/authoring/workflows/errors.js';
import { WorkflowRunNotFoundError } from '../../../src/runs/errors.js';
import { createWorkflowRunDatabase } from '../../../src/runs/runs.repository.js';
import {
  actorId,
  apiUrl,
  parseDatabaseConfig,
  workspaceId,
} from '../../support/workflow-authoring.js';
import {
  afterAllFixture2,
  beforeAllFixture1,
  database,
} from '../suites/progress/fixture.js';
import {
  draft,
  member,
  query,
  runState,
  setRole,
  startSuite,
  startTest,
  suiteState,
} from './roles/fixture.js';

let runs: ReturnType<typeof createWorkflowRunDatabase>;
beforeAll(async () => {
  await beforeAllFixture1();
  runs = createWorkflowRunDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  );
});
afterAll(async () => {
  await runs.close();
  await afterAllFixture2();
});

async function stopRequested(runId: string): Promise<boolean> {
  const state = await runState(runId);
  return state.cancel_requested_at !== null || state.status === 'canceled';
}

describe('stopping a test', () => {
  it('lets the builder who started a test stop it', async () => {
    const f = await draft(),
      builder = await member('builder');
    const { scope, runId } = await startTest(f, builder);

    await database.workflowTests.cancel({ ...scope, runId });

    expect(await stopRequested(runId)).toBe(true);
  });

  it('lets the builder who started a suite stop it, skipping what is left', async () => {
    const f = await draft(3),
      builder = await member('builder');
    const { scope, suiteId } = await startSuite(f, builder);

    await database.workflowTestSuites.cancel({ ...scope, suiteId });

    expect(await suiteState(suiteId)).toMatchObject({
      cancel_requested: true,
      stop_reason: 'user_canceled',
    });
    const detail = await database.workflowTestSuites.get({ ...scope, suiteId });
    expect(detail.cases.map((entry) => entry.status).slice(1)).toEqual([
      'skipped',
      'skipped',
    ]);
  });

  it("gives another builder 'not found' on someone else's test or suite, and changes nothing", async () => {
    const f = await draft(),
      starter = await member('builder'),
      other = await member('builder');
    const { runId } = await startTest(f, starter);
    const suiteDraft = await draft();
    const { suiteId } = await startSuite(suiteDraft, starter);
    const before = await runState(runId);

    await expect(
      database.workflowTests.cancel({
        ...f.scope,
        actorId: other,
        runId,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(
      database.workflowTestSuites.cancel({
        ...suiteDraft.scope,
        actorId: other,
        suiteId,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);

    expect(await runState(runId)).toEqual(before);
    expect(await suiteState(suiteId)).toMatchObject({
      status: 'running',
      cancel_requested: false,
      stop_reason: null,
    });
  });

  it("refuses a builder on someone else's finished test the same way, so the outcome doesn't tell them apart", async () => {
    const f = await draft(),
      starter = await member('builder'),
      other = await member('builder');
    const { scope, runId } = await startTest(f, starter);
    await database.workflowTests.cancel({ ...scope, runId });
    await query(
      "update app.workflow_runs set status='canceled',completed_at=clock_timestamp() where id=$1",
      [runId],
    );

    await expect(
      database.workflowTests.cancel({ ...f.scope, actorId: other, runId }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(
      database.workflowTests.cancel({ ...scope, runId }),
    ).resolves.toBeUndefined();
  });

  it("still lets an owner or admin stop anyone's test", async () => {
    for (const manager of [actorId, await member('admin')]) {
      const f = await draft(),
        starter = await member('builder');
      const { runId } = await startTest(f, starter);
      await database.workflowTests.cancel({
        ...f.scope,
        actorId: manager,
        runId,
      });
      expect(await stopRequested(runId)).toBe(true);
    }
  });

  it('stops counting a starter who has lost the role that can test', async () => {
    const f = await draft(),
      starter = await member('builder');
    const { scope, runId } = await startTest(f, starter);
    const before = await runState(runId);
    await setRole(starter, 'operator');

    await expect(
      database.workflowTests.cancel({ ...scope, runId }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    expect(await runState(runId)).toEqual(before);
  });

  it("doesn't open the real runs' cancel to a builder, even for their own test", async () => {
    const f = await draft(),
      builder = await member('builder');
    const { runId } = await startTest(f, builder);
    const before = await runState(runId);

    await expect(
      runs.cancel({ workspaceId, actorId: builder, runId }),
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
    expect(await runState(runId)).toEqual(before);
  });
});
