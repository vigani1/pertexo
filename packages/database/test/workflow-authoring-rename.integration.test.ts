import { describe, expect, it } from 'vitest';

import {
  actorId,
  apiPool,
  apiUrl,
  authoring,
  createHash,
  createWorkflowAuthoringDatabase,
  deferred,
  emptyGraph,
  otherActorId,
  otherWorkflowId,
  parseDatabaseConfig,
  queryAsOwner,
  randomUUID,
  saveCurrentDraft,
  waitForOperationEntry,
  waitForPostgresLock,
  withApplicationName,
  workspaceId,
} from './support/workflow-authoring.integration.support.js';

type NameFacts = Readonly<{
  name: string;
  nameRevision: number;
  lifecycleRevision: number;
  draftRevision: number;
  receipts: number;
  audits: number;
}>;

async function createNamed(name: string): Promise<string> {
  const created = await authoring.createWorkflow({
    actorId,
    emptyGraph,
    idempotencyKey: `rename-create-${randomUUID()}`,
    name,
    workspaceId,
  });
  return created.workflowId;
}

async function nameFacts(workflowId: string): Promise<NameFacts> {
  const [row] = await queryAsOwner<{
    name: string;
    name_revision: number;
    lifecycle_revision: number;
    draft_revision: number;
    receipts: string;
    audits: string;
  }>(
    `select workflow.name,workflow.name_revision,workflow.lifecycle_revision,
            draft.revision draft_revision,
            (select count(*) from app.idempotency_records
              where resource_id=workflow.id and operation='workflow.rename')::text receipts,
            (select count(*) from app.audit_events
              where target_id=workflow.id and action='workflow.renamed')::text audits
       from app.workflows workflow
       join app.workflow_drafts draft
         on draft.workspace_id=workflow.workspace_id
        and draft.workflow_id=workflow.id
      where workflow.id=$1`,
    [workflowId],
    workspaceId,
  );
  if (row === undefined) throw new Error('Rename facts are missing');
  return {
    name: row.name,
    nameRevision: row.name_revision,
    lifecycleRevision: row.lifecycle_revision,
    draftRevision: row.draft_revision,
    receipts: Number(row.receipts),
    audits: Number(row.audits),
  };
}

function rename(
  workflowId: string,
  overrides: Partial<Parameters<typeof authoring.renameWorkflow>[0]> = {},
) {
  return authoring.renameWorkflow({
    actorId,
    expectedNameRevision: 1,
    idempotencyKey: `rename-${workflowId}`,
    name: 'Invoice sync',
    workflowId,
    workspaceId,
    ...overrides,
  });
}

describe('workflow rename command persistence (ADR 041)', () => {
  it('grants the API runtime only the name and its revision for renames', async () => {
    const result = await apiPool.query<Record<string, boolean>>(
      `select
         has_column_privilege(current_user,'app.workflows','name','UPDATE') name,
         has_column_privilege(current_user,'app.workflows','name_revision','UPDATE') name_revision,
         has_column_privilege(current_user,'app.workflows','created_by','UPDATE') created_by,
         has_column_privilege(current_user,'app.workflows','workspace_id','UPDATE') workspace_id`,
    );
    expect(result.rows[0]).toEqual({
      name: true,
      name_revision: true,
      created_by: false,
      workspace_id: false,
    });
  });

  it('renames once at the expected revision and replays the exact receipt', async () => {
    const workflowId = await createNamed('Invoices');
    const before = await nameFacts(workflowId);
    expect(before).toMatchObject({ nameRevision: 1, receipts: 0, audits: 0 });

    const accepted = await rename(workflowId, {
      name: '  Invoice sync  ',
      requestId: 'rename-request',
      traceId: 'rename-trace',
    });
    expect(accepted).toMatchObject({
      replayed: false,
      workflow: { name: 'Invoice sync', nameRevision: 2, lifecycleRevision: 1 },
    });
    expect(await nameFacts(workflowId)).toEqual({
      ...before,
      name: 'Invoice sync',
      nameRevision: 2,
      receipts: 1,
      audits: 1,
    });
    const [audit] = await queryAsOwner<{
      actor_user_id: string;
      metadata: unknown;
      request_id: string;
      trace_id: string;
    }>(
      `select actor_user_id::text,metadata,request_id,trace_id
         from app.audit_events
        where target_id=$1 and action='workflow.renamed'`,
      [workflowId],
      workspaceId,
    );
    expect(audit).toEqual({
      actor_user_id: actorId,
      metadata: {
        fromName: 'Invoices',
        toName: 'Invoice sync',
        fromNameRevision: 1,
        toNameRevision: 2,
      },
      request_id: 'rename-request',
      trace_id: 'rename-trace',
    });

    // A later rename must not change what the first command's retry returns.
    await rename(workflowId, {
      expectedNameRevision: 2,
      idempotencyKey: `rename-later-${workflowId}`,
      name: 'Invoice sync (EU)',
    });
    await expect(rename(workflowId, { name: 'Invoice sync' })).resolves.toEqual(
      { replayed: true, workflow: accepted.workflow },
    );
    await expect(
      rename(workflowId, { name: 'Something else' }),
    ).rejects.toMatchObject({ name: 'WorkflowIdempotencyConflictError' });
    expect(await nameFacts(workflowId)).toMatchObject({
      name: 'Invoice sync (EU)',
      nameRevision: 3,
      receipts: 2,
      audits: 2,
    });
  });

  it('rejects a stale revision without a mutation and reports the current one', async () => {
    const workflowId = await createNamed('Payroll');
    await rename(workflowId, { name: 'Payroll run' });
    const before = await nameFacts(workflowId);

    await expect(
      rename(workflowId, {
        idempotencyKey: `rename-stale-${workflowId}`,
        name: 'Payroll export',
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowNameRevisionConflictError',
      currentRevision: 2,
    });
    expect(await nameFacts(workflowId)).toEqual(before);
  });

  it('treats the same name at the current revision as a no-op receipt', async () => {
    const workflowId = await createNamed('Onboarding');
    const result = await rename(workflowId, { name: ' Onboarding ' });
    expect(result).toMatchObject({
      replayed: false,
      workflow: { name: 'Onboarding', nameRevision: 1 },
    });
    expect(await nameFacts(workflowId)).toMatchObject({
      name: 'Onboarding',
      nameRevision: 1,
      receipts: 1,
      audits: 0,
    });
  });

  it('keeps the name revision independent of drafts and lifecycle', async () => {
    const workflowId = await createNamed('Leads');
    await saveCurrentDraft(authoring, {
      actorId,
      expectedRevision: 1,
      graphJson: emptyGraph,
      workflowId,
      workspaceId,
    });
    for (const command of ['archive', 'restore'] as const)
      await authoring.transitionWorkflowLifecycle({
        actorId,
        command,
        expectedLifecycleRevision: command === 'archive' ? 1 : 2,
        idempotencyKey: `rename-${command}-${workflowId}`,
        workflowId,
        workspaceId,
      });
    await expect(
      rename(workflowId, { name: 'Leads intake' }),
    ).resolves.toMatchObject({
      replayed: false,
      workflow: { name: 'Leads intake', nameRevision: 2, lifecycleRevision: 3 },
    });
    expect(await nameFacts(workflowId)).toMatchObject({
      draftRevision: 2,
      lifecycleRevision: 3,
      nameRevision: 2,
    });
  });

  it('reads an archived workflow as read-only, but still replays a completed rename', async () => {
    const workflowId = await createNamed('Refunds');
    const accepted = await rename(workflowId, { name: 'Refund review' });
    await authoring.transitionWorkflowLifecycle({
      actorId,
      command: 'archive',
      expectedLifecycleRevision: 1,
      idempotencyKey: `rename-archive-${workflowId}`,
      workflowId,
      workspaceId,
    });

    await expect(
      rename(workflowId, { name: 'Refund review' }),
    ).resolves.toEqual({ replayed: true, workflow: accepted.workflow });
    await expect(
      rename(workflowId, {
        expectedNameRevision: 2,
        idempotencyKey: `rename-archived-${workflowId}`,
        name: 'Refunds (old)',
      }),
    ).rejects.toMatchObject({ name: 'WorkflowNotFoundError' });
    expect(await nameFacts(workflowId)).toMatchObject({
      name: 'Refund review',
      nameRevision: 2,
      audits: 1,
    });
  });

  it('hides other tenants and denies members without editing authority', async () => {
    await expect(
      rename(otherWorkflowId, {
        idempotencyKey: `rename-foreign-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ name: 'WorkflowNotFoundError' });
    await expect(
      rename(otherWorkflowId, {
        actorId: otherActorId,
        idempotencyKey: `rename-cross-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ name: 'WorkflowNotFoundError' });

    const workflowId = await createNamed('Support');
    for (const role of ['viewer', 'operator'] as const) {
      const memberId = randomUUID();
      await queryAsOwner(
        `insert into app.users (id,email,display_name,status)
         values ($1,$2,$3,'active')`,
        [memberId, `${memberId}@example.test`, `Rename ${role}`],
        workspaceId,
      );
      await queryAsOwner(
        `insert into app.workspace_memberships (workspace_id,user_id,role,status)
         values ($1,$2,$3,'active')`,
        [workspaceId, memberId, role],
        workspaceId,
      );
      await expect(
        rename(workflowId, {
          actorId: memberId,
          idempotencyKey: `rename-${role}-${workflowId}`,
        }),
      ).rejects.toMatchObject({ name: 'WorkflowNotFoundError' });
    }
    expect(await nameFacts(workflowId)).toMatchObject({
      name: 'Support',
      receipts: 0,
    });
  });

  it('lets exactly one of two racing renames at the same revision win', async () => {
    const workflowId = await createNamed('Racing');
    const firstLocked = deferred();
    const releaseFirst = deferred();
    const firstApplication = `rnf-${randomUUID()}`;
    const secondApplication = `rns-${randomUUID()}`;
    const first = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(apiUrl, firstApplication),
        max: 1,
      }),
      {
        testHooks: {
          afterRenameStep: async (step) => {
            if (step !== 'workflow') return;
            firstLocked.resolve();
            await releaseFirst.promise;
          },
        },
      },
    );
    const second = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(apiUrl, secondApplication),
        max: 1,
      }),
    );
    try {
      const winner = first.renameWorkflow({
        actorId,
        expectedNameRevision: 1,
        idempotencyKey: `rename-race-first-${workflowId}`,
        name: 'Racing first',
        workflowId,
        workspaceId,
      });
      await waitForOperationEntry(firstLocked.promise, winner, 'first rename');
      const loser = second.renameWorkflow({
        actorId,
        expectedNameRevision: 1,
        idempotencyKey: `rename-race-second-${workflowId}`,
        name: 'Racing second',
        workflowId,
        workspaceId,
      });
      await waitForPostgresLock(secondApplication);
      releaseFirst.resolve();
      await expect(winner).resolves.toMatchObject({
        workflow: { name: 'Racing first', nameRevision: 2 },
      });
      await expect(loser).rejects.toMatchObject({
        name: 'WorkflowNameRevisionConflictError',
        currentRevision: 2,
      });
    } finally {
      releaseFirst.resolve();
      await Promise.all([first.close(), second.close()]);
    }
    expect(await nameFacts(workflowId)).toMatchObject({
      name: 'Racing first',
      nameRevision: 2,
      receipts: 1,
      audits: 1,
    });
  });

  it('rolls back every rename step, including the command receipt', async () => {
    for (const step of ['claim', 'workflow', 'audit', 'idempotency'] as const) {
      const workflowId = await createNamed(`Rollback ${step}`);
      const before = await nameFacts(workflowId);
      const faulting = createWorkflowAuthoringDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
        {
          testHooks: {
            afterRenameStep: (reached) =>
              reached === step
                ? Promise.reject(new Error(`injected-${step}`))
                : Promise.resolve(),
          },
        },
      );
      try {
        await expect(
          faulting.renameWorkflow({
            actorId,
            expectedNameRevision: 1,
            idempotencyKey: `rename-rollback-${workflowId}`,
            name: `Renamed ${step}`,
            workflowId,
            workspaceId,
          }),
        ).rejects.toThrow(`injected-${step}`);
      } finally {
        await faulting.close();
      }
      expect(await nameFacts(workflowId)).toEqual(before);
      await expect(
        rename(workflowId, {
          idempotencyKey: `rename-rollback-${workflowId}`,
          name: `Renamed ${step}`,
        }),
      ).resolves.toMatchObject({
        replayed: false,
        workflow: { nameRevision: 2 },
      });
    }
  });

  it('replays a receipt completed before name revisions existed as revision one', async () => {
    const workflowId = await createNamed('Legacy receipt');
    const idempotencyKey = `legacy-archive-${workflowId}`;
    const command = {
      actorId,
      command: 'archive' as const,
      expectedLifecycleRevision: 1,
      idempotencyKey,
      workflowId,
      workspaceId,
    };
    const archived = await authoring.transitionWorkflowLifecycle(command);
    await queryAsOwner(
      `update app.idempotency_records
          set result_ref=result_ref #- '{workflow,nameRevision}'
        where workspace_id=$1 and operation='workflow.archive' and key_hash=$2`,
      [workspaceId, createHash('sha256').update(idempotencyKey).digest('hex')],
      workspaceId,
    );
    await expect(
      authoring.transitionWorkflowLifecycle(command),
    ).resolves.toEqual({
      replayed: true,
      workflow: { ...archived.workflow, nameRevision: 1 },
    });
  });
});
