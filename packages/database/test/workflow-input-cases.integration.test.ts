import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWorkflowInputCaseDatabase,
  WorkflowInputCaseLimitError,
  WorkflowInputCaseRevisionConflictError,
} from '../src/authoring/input-cases.js';
import { WorkflowNotFoundError } from '../src/authoring/workflows/errors.js';
import { IdempotencyConflictError } from '../src/platform/idempotency.js';
import { createRetentionDatabase } from '../src/lifecycle/retention.js';
import {
  actorId,
  workspaceId,
  apiUrl,
  apiPool,
  dispatcherUrl,
  enforceTestRetention,
  authoring,
  currentRepresentationTag,
  emptyGraph,
  executeAsOwner,
  queryAsOwner,
  randomUUID,
  parseDatabaseConfig,
  identity,
  ownerPool,
  waitForPostgresLock,
  withApplicationName,
  otherActorId,
  purgeTestWorkspace,
} from './support/workflow-authoring.integration.support.js';

let database: ReturnType<typeof createWorkflowInputCaseDatabase>;
beforeAll(() => {
  database = createWorkflowInputCaseDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
  );
});
afterAll(async () => {
  await database.close();
});
async function fixture(selectedWorkspaceId = workspaceId) {
  const created = await authoring.createWorkflow({
    actorId,
    workspaceId: selectedWorkspaceId,
    emptyGraph,
    name: 'Input cases',
    idempotencyKey: randomUUID(),
  });
  const workflowId = created.workflowId;
  const publication = await authoring.publishWorkflow({
    actorId,
    workspaceId: selectedWorkspaceId,
    workflowId,
    representationTag: await currentRepresentationTag(
      authoring,
      selectedWorkspaceId,
      workflowId,
      actorId,
    ),
    idempotencyKey: randomUUID(),
    requestHash: '0'.repeat(64),
  });
  return {
    actorId,
    workspaceId: selectedWorkspaceId,
    workflowId,
    workflowVersionId: publication.version.id,
  };
}
describe('bounded version-contextual run-input cases', () => {
  it('lists metadata only, gets detached canonical input and replays identifiers without names or JSON in receipts/audits', async () => {
    const scope = await fixture();
    const command = {
      ...scope,
      name: '  Synthetic input  ',
      input: { b: 2, a: 1 },
      idempotencyKey: randomUUID(),
    };
    const created = await database.createCase(command);
    expect(await database.createCase(command)).toEqual({
      ...created,
      replayed: true,
    });
    const list = await database.listCases({ ...scope, limit: 1 });
    expect(list.items[0]).toMatchObject({
      id: created.caseId,
      name: 'Synthetic input',
      workflowVersionId: scope.workflowVersionId,
      revision: 1,
    });
    expect(list.items[0]).not.toHaveProperty('input');
    expect(
      (await database.getCase({ ...scope, caseId: created.caseId })).case.input,
    ).toEqual({ a: 1, b: 2 });
    const facts = await queryAsOwner<{ receipt: unknown; metadata: unknown }>(
      `select to_jsonb(r) receipt,a.metadata from app.idempotency_records r join app.audit_events a on a.target_id=r.resource_id where r.resource_id=$1`,
      [created.caseId],
    );
    expect(JSON.stringify(facts)).not.toContain('Synthetic input');
    expect(JSON.stringify(facts)).not.toContain('"input"');
    await expect(
      database.createCase({ ...command, input: { changed: true } }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    const duplicated = await authoring.duplicateWorkflow({
      workspaceId: scope.workspaceId,
      workflowId: scope.workflowId,
      actorId: scope.actorId,
      name: 'Independent workflow copy',
      source: { kind: 'version', versionId: scope.workflowVersionId },
      idempotencyKey: randomUUID(),
    });
    expect(
      (
        await database.listCases({
          ...scope,
          workflowId: duplicated.workflowId,
          limit: 10,
        })
      ).items,
    ).toEqual([]);
  });
  it('serializes duplicate creation and strong CAS, exact retries precede stale revision, deletion never resurrects', async () => {
    const scope = await fixture();
    const command = {
      ...scope,
      name: 'Fixture',
      input: null,
      idempotencyKey: randomUUID(),
    };
    const pair = await Promise.all([
      database.createCase(command),
      database.createCase(command),
    ]);
    expect(new Set(pair.map((item) => item.caseId)).size).toBe(1);
    expect(pair.filter((item) => item.replayed)).toHaveLength(1);
    const caseId = pair[0].caseId;
    const edit = {
      ...scope,
      caseId,
      expectedRevision: 1,
      name: 'Edited',
      input: [1, 2],
      idempotencyKey: randomUUID(),
    };
    expect((await database.updateCase(edit)).revision).toBe(2);
    expect(await database.updateCase(edit)).toEqual({
      caseId,
      revision: 2,
      replayed: true,
    });
    await expect(
      database.updateCase({ ...edit, idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(WorkflowInputCaseRevisionConflictError);
    const deletion = {
      ...scope,
      caseId,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    };
    expect((await database.deleteCase(deletion)).revision).toBe(3);
    await expect(database.getCase({ ...scope, caseId })).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    expect(await database.deleteCase(deletion)).toEqual({
      caseId,
      revision: 3,
      replayed: true,
    });
    expect(await database.createCase(command)).toEqual({
      caseId,
      revision: 1,
      replayed: true,
    });
    await expect(database.getCase({ ...scope, caseId })).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
  });
  it('makes concurrent active-count admission atomic and deletion only releases counts, not retained bytes', async () => {
    const scope = await fixture();
    const created = await Promise.all(
      Array.from({ length: 19 }, (_, index) =>
        database.createCase({
          ...scope,
          name: `Fixture ${String(index)}`,
          input: null,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    const outcomes = await Promise.allSettled(
      [0, 1].map((index) =>
        database.createCase({
          ...scope,
          name: `Race ${String(index)}`,
          input: null,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(
      outcomes.find((item) => item.status === 'rejected')?.reason as unknown,
    ).toBeInstanceOf(WorkflowInputCaseLimitError);
    const retainedBefore = await queryAsOwner<{ bytes: string }>(
      'select sum(canonical_bytes) bytes from app.workflow_input_case_payloads where workspace_id=$1',
      [workspaceId],
    );
    const firstCreated = created[0];
    if (!firstCreated) throw new Error('Expected created case');
    await database.deleteCase({
      ...scope,
      caseId: firstCreated.caseId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await database.createCase({
      ...scope,
      name: 'New active slot',
      input: null,
      idempotencyKey: randomUUID(),
    });
    const retainedAfter = await queryAsOwner<{ bytes: string }>(
      'select sum(canonical_bytes) bytes from app.workflow_input_case_payloads where workspace_id=$1',
      [workspaceId],
    );
    expect(Number(retainedAfter[0]?.bytes)).toBe(
      Number(retainedBefore[0]?.bytes) + 4,
    );
  });
  it('retains replacement bytes until paged cleanup and charges update churn', async () => {
    const scope = await fixture();
    const created = await database.createCase({
      ...scope,
      name: 'Churn',
      input: 'x'.repeat(65000),
      idempotencyKey: randomUUID(),
    });
    let revision = 1;
    let denied = false;
    for (let index = 0; index < 70; index += 1) {
      try {
        const result = await database.updateCase({
          ...scope,
          caseId: created.caseId,
          expectedRevision: revision,
          name: 'Churn',
          input: 'x'.repeat(65000),
          idempotencyKey: randomUUID(),
        });
        revision = result.revision;
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(WorkflowInputCaseLimitError);
        denied = true;
        break;
      }
    }
    expect(denied).toBe(true);
    const retention = createRetentionDatabase(
      parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
      { pageSize: 10 },
    );
    try {
      expect((await retention.enforce()).removed.input_case_payloads).toBe(10);
    } finally {
      await retention.close();
    }
    const remaining = await queryAsOwner<{ count: string }>(
      'select count(*) from app.workflow_input_case_payloads where workspace_id=$1 and case_id=$2',
      [workspaceId, created.caseId],
    );
    expect(Number(remaining[0]?.count)).toBeGreaterThan(1);
    expect(
      (await database.getCase({ ...scope, caseId: created.caseId })).case
        .revision,
    ).toBe(revision);
  });
  it('rejects bounds, cycles and PostgreSQL-invalid unicode before any persistence', async () => {
    const scope = await fixture();
    for (const input of [
      'x'.repeat(65535),
      Array.from({ length: 10001 }, () => 0),
      '\u0000',
      '\ud800',
    ]) {
      await expect(
        database.createCase({
          ...scope,
          name: 'Invalid',
          input,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    const value: Record<string, unknown> = {};
    value.self = value;
    await expect(
      database.createCase({
        ...scope,
        name: 'Invalid',
        input: value,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(TypeError);
    let deep: unknown = null;
    for (let index = 0; index < 65; index += 1) deep = [deep];
    await expect(
      database.createCase({
        ...scope,
        name: 'Invalid',
        input: deep,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
  it('forces tenant RLS, keeps a case on its workflow version and denies app physical erasure', async () => {
    const scope = await fixture();
    const created = await database.createCase({
      ...scope,
      name: 'Protocol fence',
      input: null,
      idempotencyKey: randomUUID(),
    });
    const client = await apiPool.connect();
    try {
      await client.query('begin');
      await client.query(
        "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
        [workspaceId, actorId],
      );
      await expect(
        client.query(
          'update app.workflow_input_cases set workflow_version_id=$2 where id=$1',
          [created.caseId, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('rollback');
      client.release();
    }
    expect(
      (await apiPool.query('select * from app.workflow_input_cases')).rows,
    ).toEqual([]);
    await expect(
      apiPool.query('delete from app.workflow_input_cases'),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('rechecks current authority even for retained exact receipts', async () => {
    const scope = await fixture();
    const command = {
      ...scope,
      name: 'Current authority',
      input: null,
      idempotencyKey: randomUUID(),
    };
    await database.createCase(command);
    await queryAsOwner(
      "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
      [workspaceId, actorId],
      workspaceId,
    );
    try {
      await expect(database.createCase(command)).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
      await expect(
        database.listCases({ ...scope, limit: 10 }),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    } finally {
      await queryAsOwner(
        "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
        [workspaceId, actorId],
        workspaceId,
      );
    }
    expect((await database.createCase(command)).replayed).toBe(true);
  });
  it('locks workspace before membership and rejects a revocation that wins admission', async () => {
    const scope = await fixture();
    const appName = `case-revocation-${randomUUID()}`;
    const contender = createWorkflowInputCaseDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(apiUrl, appName),
        max: 1,
      }),
    );
    const blocker = await ownerPool.connect();
    let attempt: Promise<unknown> | undefined;
    try {
      await blocker.query('begin');
      await blocker.query('set local role pertexo_owner');
      await blocker.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await blocker.query(
        'select id from app.workspaces where id=$1 for update',
        [workspaceId],
      );
      attempt = contender.createCase({
        ...scope,
        name: 'Raced revocation',
        input: null,
        idempotencyKey: randomUUID(),
      });
      void attempt.catch(() => undefined);
      await waitForPostgresLock(appName);
      await blocker.query(
        "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
        [workspaceId, actorId],
      );
      await blocker.query('commit');
      await expect(attempt).rejects.toBeInstanceOf(WorkflowNotFoundError);
    } finally {
      await blocker.query('rollback');
      blocker.release();
      await Promise.allSettled(attempt ? [attempt] : []);
      await contender.close();
      await queryAsOwner(
        "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
        [workspaceId, actorId],
        workspaceId,
      );
    }
  });
  // This proof deliberately commits 200 independent commands through the real
  // authority, receipt and quota transactions; coverage instrumentation adds
  // fixture cost. Keep a bounded test budget, not a production timeout change.
  it('enforces the workspace active-count cap independently of workflow and byte quotas', async () => {
    const id = randomUUID();
    const own = await identity.createWorkspaceWithOwner({
      id,
      name: 'Workspace case quota',
      slug: `case-quota-${id}`,
      ownerUserId: actorId,
      idempotencyKey: randomUUID(),
    });
    for (let index = 0; index < 10; index += 1) {
      const scope = await fixture(own.id);
      await Promise.all(
        Array.from({ length: 20 }, (_, item) =>
          database.createCase({
            ...scope,
            name: `Case ${String(item)}`,
            input: null,
            idempotencyKey: randomUUID(),
          }),
        ),
      );
    }
    const scope = await fixture(own.id);
    await expect(
      database.createCase({
        ...scope,
        name: 'Over workspace cap',
        input: null,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ kind: 'workspace_count' });
  }, 20_000);
  it('removes expired receipts and rejections so a key can be reused', async () => {
    const scope = await fixture();
    const key = randomUUID();
    const command = {
      ...scope,
      name: 'Held fixture',
      input: null,
      idempotencyKey: key,
    };
    const created = await database.createCase(command);
    await executeAsOwner(
      `insert into app.workflow_manual_start_rejections(workspace_id,workflow_id,scope,key_hash,request_hash,expected_version_id,observed_version_id,created_at,expires_at) values($1,$2,$3,$4,$5,$6,$7,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day')`,
      [
        workspaceId,
        scope.workflowId,
        `workflow:${scope.workflowId}:manual`,
        'c'.repeat(64),
        'd'.repeat(64),
        randomUUID(),
        scope.workflowVersionId,
      ],
    );
    await database.deleteCase({
      ...scope,
      caseId: created.caseId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await executeAsOwner(
      "update app.idempotency_records set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' where workspace_id=$1 and operation like 'workflow.inputcase.%'",
      [workspaceId],
    );
    expect((await enforceTestRetention()).manual_start_rejections).toBe(1);
    const next = await database.createCase(command);
    expect(next.caseId).not.toBe(created.caseId);
    expect(next.replayed).toBe(false);
  });
  it('purges case receipts and bounded payload pages before versions, including unexpired manual rejection receipts', async () => {
    const id = randomUUID();
    const ownWorkspace = await identity.createWorkspaceWithOwner({
      id,
      name: 'Owned case purge',
      slug: `case-purge-${id}`,
      ownerUserId: actorId,
      idempotencyKey: randomUUID(),
    });
    const scope = await fixture(ownWorkspace.id);
    const created = await database.createCase({
      ...scope,
      name: 'Purge fixture',
      input: 'x'.repeat(65000),
      idempotencyKey: randomUUID(),
    });
    for (let revision = 1; revision < 20; revision += 1)
      await database.updateCase({
        ...scope,
        caseId: created.caseId,
        expectedRevision: revision,
        name: 'Purge fixture',
        input: 'x'.repeat(65000),
        idempotencyKey: randomUUID(),
      });
    await executeAsOwner(
      `insert into app.workflow_manual_start_rejections(workspace_id,workflow_id,scope,key_hash,request_hash,expected_version_id,observed_version_id) values($1,$2,$3,$4,$5,$6,$7)`,
      [
        scope.workspaceId,
        scope.workflowId,
        `workflow:${scope.workflowId}:manual`,
        'e'.repeat(64),
        'f'.repeat(64),
        randomUUID(),
        scope.workflowVersionId,
      ],
    );
    const payloadBytes = async () =>
      Number(
        (
          await queryAsOwner<{ bytes: string }>(
            'select coalesce(sum(canonical_bytes),0) bytes from app.workflow_input_case_payloads where workspace_id=$1',
            [scope.workspaceId],
          )
        )[0]?.bytes,
      );
    let remaining = await payloadBytes();
    const steps = await purgeTestWorkspace(scope.workspaceId, {
      pageSize: 100,
      afterPage: async () => {
        const after = await payloadBytes();
        expect(remaining - after).toBeLessThanOrEqual(1048576);
        remaining = after;
      },
    });
    expect(
      steps.filter((step) => step === 'workflow_input_case_payloads'),
    ).toHaveLength(2);
    expect(steps.indexOf('workflow_input_cases')).toBeLessThan(
      steps.indexOf('workflow_versions'),
    );
    const rows = await queryAsOwner<{
      cases: string;
      receipts: string;
      negative: string;
      versions: string;
    }>(
      `select (select count(*) from app.workflow_input_cases where workspace_id=$1) cases,(select count(*) from app.idempotency_records where workspace_id=$1) receipts,(select count(*) from app.workflow_manual_start_rejections where workspace_id=$1) negative,(select count(*) from app.workflow_versions where workspace_id=$1) versions`,
      [scope.workspaceId],
      scope.workspaceId,
    );
    expect(rows[0]).toEqual({
      cases: '0',
      receipts: '0',
      negative: '0',
      versions: '0',
    });
  });
  it('allows viewer/operator reads but independently denies authoring, and keeps archived cases inspect-only', async () => {
    const scope = await fixture();
    const command = {
      ...scope,
      name: 'Role-scoped case',
      input: null,
      idempotencyKey: randomUUID(),
    };
    const created = await database.createCase(command);
    await queryAsOwner(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'viewer','active')",
      [workspaceId, otherActorId],
      workspaceId,
    );
    for (const role of ['viewer', 'operator']) {
      await queryAsOwner(
        'update app.workspace_memberships set role=$3 where workspace_id=$1 and user_id=$2',
        [workspaceId, otherActorId, role],
        workspaceId,
      );
      expect(
        (
          await database.getCase({
            ...scope,
            actorId: otherActorId,
            caseId: created.caseId,
          })
        ).case.name,
      ).toBe('Role-scoped case');
      await expect(
        database.createCase({
          ...command,
          actorId: otherActorId,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    }
    await authoring.transitionWorkflowLifecycle({
      ...scope,
      command: 'archive',
      expectedLifecycleRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(
      (await database.getCase({ ...scope, caseId: created.caseId })).case.name,
    ).toBe('Role-scoped case');
    await expect(
      database.createCase({ ...command, idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    expect((await database.createCase(command)).replayed).toBe(true);
    const restarted = createWorkflowInputCaseDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
    );
    try {
      expect(await restarted.createCase(command)).toEqual({
        caseId: created.caseId,
        revision: 1,
        replayed: true,
      });
    } finally {
      await restarted.close();
    }
  });
});
