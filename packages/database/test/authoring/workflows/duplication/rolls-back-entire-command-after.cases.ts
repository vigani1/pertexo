import { expect, it } from 'vitest';
import {
  WorkflowNotFoundError,
  Pool,
  actorId,
  apiUrl,
  authoring,
  createWorkflowAuthoringDatabase,
  duplicateWrite,
  emptyGraph,
  failAtWrite,
  holdAtWrite,
  finishControlledScenario,
  migrationUrl,
  parseDatabaseConfig,
  queryAsOwner,
  randomUUID,
  waitForOperationEntry,
  waitForPostgresLock,
  withApplicationName,
  workspaceId,
} from '../../../support/workflow-authoring.js';
import { source, command, facts, commandFacts } from './fixture.js';

export function registerRollsBackEntireCommandAfter(): void {
  it.each(['claim', 'workflow', 'draft', 'audit', 'idempotency'] as const)(
    'rolls back the entire command after a failed %s write',
    async (step) => {
      const original = await source();
      const input = await command(original.workflowId);
      const before = await commandFacts();
      const fault = await failAtWrite(duplicateWrite(step, input.name));
      try {
        await expect(authoring.duplicateWorkflow(input)).rejects.toThrow(
          fault.message,
        );
      } finally {
        await fault.remove();
      }
      expect(await commandFacts()).toEqual(before);
      const copied = await authoring.duplicateWorkflow(input);
      expect((await facts(copied.workflowId)).revision).toBe(1);
    },
  );

  it('replays retained archived source or destination without recreating a copy, but rejects a new command on an archived source', async () => {
    for (const archiveSource of [true, false]) {
      const original = await source();
      const input = await command(original.workflowId);
      const copied = await authoring.duplicateWorkflow(input);
      await authoring.transitionWorkflowLifecycle({
        actorId,
        workspaceId,
        workflowId: archiveSource ? original.workflowId : copied.workflowId,
        command: 'archive',
        expectedLifecycleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      const before = await commandFacts();
      expect(await authoring.duplicateWorkflow(input)).toEqual(copied);
      if (archiveSource)
        await expect(
          authoring.duplicateWorkflow({
            ...input,
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(WorkflowNotFoundError);
      expect(await commandFacts()).toEqual(before);
    }
  });

  it('holds the source workflow/draft lock until the copy commits while a source save waits', async () => {
    const original = await source();
    const input = await command(original.workflowId);
    const hold = await holdAtWrite(duplicateWrite('workflow', input.name));
    const copying = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
    );
    const application = `duplicate-save-${randomUUID()}`;
    const saving = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(apiUrl, application),
        max: 1,
      }),
    );
    let copy: ReturnType<typeof copying.duplicateWorkflow> | undefined;
    let save: ReturnType<typeof saving.saveDraft> | undefined;
    let primaryError: unknown;
    try {
      copy = copying.duplicateWorkflow(input);
      await waitForOperationEntry(
        hold.reached(),
        copy,
        'duplicate source lock',
      );
      save = saving.saveDraft({
        actorId,
        workspaceId,
        workflowId: original.workflowId,
        expectedRevision: 1,
        representationTag: input.representationTag,
        graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 3000 } },
      });
      void save.catch(() => undefined);
      await waitForPostgresLock(application);
      await hold.release();
      const copied = await copy;
      await save;
      expect((await facts(copied.workflowId)).graph).toEqual(emptyGraph);
      expect((await facts(original.workflowId)).revision).toBe(2);
    } catch (error) {
      primaryError = error;
    }
    await finishControlledScenario({
      label: 'duplicate/source save race',
      primaryError,
      release: () => void hold.release(),
      operations: [copy, save],
      close: [() => copying.close(), () => saving.close(), () => hold.remove()],
    });
  });

  it('holds authority, source and catalog locks while concurrent archive, membership suspension and release changes wait', async () => {
    for (const race of ['archive', 'membership'] as const) {
      const original = await source();
      const copying = createWorkflowAuthoringDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      );
      const input = await command(original.workflowId, copying);
      const hold = await holdAtWrite(duplicateWrite('workflow', input.name));
      const application = `duplicate-${race}-${randomUUID()}`;
      const pool = new Pool({
        connectionString: withApplicationName(migrationUrl, application),
        max: 1,
      });
      const client = await pool.connect();
      let copy: ReturnType<typeof copying.duplicateWorkflow> | undefined;
      let mutation: Promise<unknown> | undefined;
      let primaryError: unknown;
      let transactionOpen = false;
      try {
        copy = copying.duplicateWorkflow(input);
        await waitForOperationEntry(
          hold.reached(),
          copy,
          `duplicate ${race} lock`,
        );
        await client.query('begin');
        transactionOpen = true;
        await client.query('set local role pertexo_owner');
        await client.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        mutation = client.query(
          race === 'archive'
            ? "update app.workflows set lifecycle_status='archived' where workspace_id=$1 and id=$2"
            : "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
          [workspaceId, race === 'archive' ? original.workflowId : actorId],
        );
        void mutation.catch(() => undefined);
        await waitForPostgresLock(application);
        await hold.release();
        expect(await copy).toHaveProperty('workflowId');
        await mutation;
        await client.query('rollback');
        transactionOpen = false;
      } catch (error) {
        primaryError = error;
      }
      await finishControlledScenario({
        label: `duplicate/${race} race`,
        primaryError,
        release: () => void hold.release(),
        operations: [copy, mutation],
        close: [
          async () => {
            try {
              if (transactionOpen) await client.query('rollback');
            } finally {
              client.release();
              await pool.end();
            }
          },
          () => copying.close(),
          () => hold.remove(),
        ],
      });
    }
  });

  it('denies replay after membership access loss and after destination erasure without recreation', async () => {
    const original = await source();
    const input = await command(original.workflowId);
    const copied = await authoring.duplicateWorkflow(input);
    await queryAsOwner(
      "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2",
      [workspaceId, actorId],
      workspaceId,
    );
    try {
      const before = await commandFacts();
      await expect(authoring.duplicateWorkflow(input)).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
      expect(await commandFacts()).toEqual(before);
    } finally {
      await queryAsOwner(
        "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
        [workspaceId, actorId],
        workspaceId,
      );
    }
    await queryAsOwner(
      'delete from app.workflows where workspace_id=$1 and id=$2',
      [workspaceId, copied.workflowId],
      workspaceId,
    );
    const before = await commandFacts();
    await expect(authoring.duplicateWorkflow(input)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    expect(await commandFacts()).toEqual(before);
  });
}
