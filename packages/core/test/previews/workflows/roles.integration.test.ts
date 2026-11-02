import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { WorkflowNotFoundError } from '../../../src/authoring/workflows/errors.js';
import {
  actorId,
  deferred,
  ownerPool,
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
  outsider,
  query,
  setMembershipStatus,
  setUserStatus,
  setWorkspaceStatus,
  startSuite,
  startTest,
} from './roles/fixture.js';

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
afterEach(() => setWorkspaceStatus('active'));

type Scope = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
}>;

const flows = (runId: string, suiteId: string) =>
  [
    ['prepare a test', (s: Scope) => database.workflowTests.prepare(s)],
    ['list tests', (s: Scope) => database.workflowTests.list(s)],
    ['read a test', (s: Scope) => database.workflowTests.get({ ...s, runId })],
    [
      'cancel a test',
      (s: Scope) => database.workflowTests.cancel({ ...s, runId }),
    ],
    ['prepare a suite', (s: Scope) => database.workflowTestSuites.prepare(s)],
    ['list suites', (s: Scope) => database.workflowTestSuites.list(s)],
    [
      'read a suite',
      (s: Scope) => database.workflowTestSuites.get({ ...s, suiteId }),
    ],
    [
      'read a suite report',
      (s: Scope) =>
        database.workflowTestSuites.report({ ...s, suiteId, ordinal: 0 }),
    ],
    [
      'cancel a suite',
      (s: Scope) => database.workflowTestSuites.cancel({ ...s, suiteId }),
    ],
    [
      'start a test',
      (s: Scope) =>
        database.workflowTests.start({
          ...s,
          idempotencyKey: crypto.randomUUID(),
          request: {
            expectedRevision: 1,
            expectedSamples: [],
            expectedEffectfulSteps: [],
            input: {},
            acknowledgeSideEffects: false,
          },
        }),
    ],
  ] as const;

async function started() {
  const f = await draft();
  // A suite's own first case counts as a running test, so two people start them.
  const { runId } = await startTest(f, await member('builder'));
  const { suiteId } = await startSuite(f, await member('builder'));
  return { f, runId, suiteId };
}

describe('who can reach a draft test or suite', () => {
  it("answers 'not found' to everyone who can't test, for every flow", async () => {
    const { f, runId, suiteId } = await started();
    const suspended = await member('builder');
    await setMembershipStatus(suspended, 'suspended');
    const deactivated = await member('builder');
    await setUserStatus(deactivated, 'suspended');
    const denied: readonly (readonly [string, string])[] = [
      ['an operator', await member('operator')],
      ['a viewer', await member('viewer')],
      ['an outsider', await outsider()],
      ['a suspended member', suspended],
      ['a deactivated user', deactivated],
    ];

    for (const [flow, run] of flows(runId, suiteId))
      for (const [who, id] of denied)
        await expect(
          run({ ...f.scope, actorId: id }),
          `${who}: ${flow}`,
        ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  }, 60_000);

  it('lets an owner, admin and builder through to every read', async () => {
    const { f, runId, suiteId } = await started();
    const people = [actorId, await member('admin'), await member('builder')];
    const reads = flows(runId, suiteId).filter(([name]) =>
      /^(prepare|list|read a (test|suite)$)/u.test(name),
    );
    for (const id of people)
      for (const [flow, run] of reads)
        await expect(
          run({ ...f.scope, actorId: id }),
          flow,
        ).resolves.toBeDefined();
  }, 60_000);

  it("gives a builder without the workflow's folder 'not found' too", async () => {
    const { f, runId, suiteId } = await started();
    const folderId = crypto.randomUUID();
    await query(
      `insert into app.workflow_folders(id,workspace_id,name,name_key,access_mode) values($1,$2,'Private','private','restricted')`,
      [folderId, workspaceId],
    );
    await query(
      'insert into app.workflow_organization_state(workflow_id,folder_id,workspace_id) values($1,$2,$3) on conflict (workspace_id,workflow_id) do update set folder_id=$2',
      [f.scope.workflowId, folderId, workspaceId],
    );
    const builder = await member('builder');

    for (const [flow, run] of flows(runId, suiteId))
      await expect(
        run({ ...f.scope, actorId: builder }),
        flow,
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  }, 60_000);
});

describe('what each workspace state allows', () => {
  it.each(['suspended', 'pending_deletion'] as const)(
    "answers 'not found' to every flow, reads included, while %s",
    async (status) => {
      const { f, runId, suiteId } = await started();
      await setWorkspaceStatus(status);
      for (const [flow, run] of flows(runId, suiteId))
        await expect(run(f.scope), flow).rejects.toBeInstanceOf(
          WorkflowNotFoundError,
        );
    },
    60_000,
  );
});

describe('how long a read may wait', () => {
  /** Keeps the test snapshots table out of reach until told to let go. */
  async function holdingTable(table: string) {
    const client = await ownerPool.connect();
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(`lock table ${table} in access exclusive mode`);
    const released = deferred();
    const finished = released.promise.then(async () => {
      await client.query('rollback');
      client.release();
    });
    return {
      release: async () => {
        released.resolve();
        await finished;
      },
    };
  }

  it('gives up on a read after 2 seconds, not before and not much after', async () => {
    const { f, runId } = await started();
    const held = await holdingTable('app.workflow_test_snapshots');
    const began = Date.now();
    try {
      const outcome = await database.workflowTests
        .get({ ...f.scope, runId })
        .then(
          () => 'answered',
          (error: unknown) => (error as Error).constructor.name,
        );
      const waited = Date.now() - began;
      expect(outcome).not.toBe('answered');
      expect(waited).toBeGreaterThanOrEqual(1_900);
      expect(waited).toBeLessThan(4_000);
    } finally {
      await held.release();
    }
    await expect(
      database.workflowTests.get({ ...f.scope, runId }),
    ).resolves.toMatchObject({ runId });
  }, 20_000);

  it('lets a change wait past that limit, and finish', async () => {
    const f = await draft();
    const builder = await member('builder');
    const held = await holdingTable('app.workflow_test_snapshots');
    const preparing = startTest(f, builder);
    let released = false;
    const letGo = new Promise<void>((resolve) => {
      setTimeout(() => {
        released = true;
        void held.release().then(resolve);
      }, 2_500);
    });
    const { runId } = await preparing;
    await letGo;
    expect(released).toBe(true);
    expect(runId).toBeTypeOf('string');
  }, 20_000);
});
