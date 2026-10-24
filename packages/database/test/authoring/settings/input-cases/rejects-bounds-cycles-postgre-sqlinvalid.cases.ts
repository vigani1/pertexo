import { expect, it } from 'vitest';
import { createWorkflowInputCaseDatabase } from '../../../../src/authoring/input-cases/repository.js';
import { WorkflowNotFoundError } from '../../../../src/authoring/workflows/errors.js';

import {
  actorId,
  workspaceId,
  apiUrl,
  apiPool,
  queryAsOwner,
  randomUUID,
  parseDatabaseConfig,
  identity,
  ownerPool,
  waitForPostgresLock,
  withApplicationName,
} from '../../../support/workflow-authoring.js';
import { database, fixture } from './fixture.js';

export function registerRejectsBoundsCyclesPostgreSQLInvalid(): void {
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
}
