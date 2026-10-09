import { describe, expect, it } from 'vitest';
import {
  IdempotencyConflictError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  CONNECTION_AUTH_TYPE,
  Pool,
  actorId,
  apiUrl,
  enforceTestRetention,
  authoring,
  createWorkflowAuthoringDatabase,
  createConnectionDatabase,
  createHash,
  currentRepresentationTag,
  deferred,
  draftNode,
  emptyGraph,
  executeAsOwner,
  identity,
  finishControlledScenario,
  otherActorId,
  otherVersionId,
  otherWorkflowId,
  otherWorkspaceId,
  migrationUrl,
  parseDatabaseConfig,
  queryAsOwner,
  randomUUID,
  saveCurrentDraft,
  waitForOperationEntry,
  waitForPostgresLock,
  withApplicationName,
  workspaceId,
  purgeTestWorkspace,
} from './support/workflow-authoring.integration.support.js';

async function source(database = authoring, graph: unknown = emptyGraph) {
  return database.createWorkflow({
    actorId,
    workspaceId,
    emptyGraph: graph,
    name: 'Duplication source',
    idempotencyKey: `duplicate-source-${randomUUID()}`,
  });
}

async function command(workflowId: string, database = authoring) {
  return {
    actorId,
    workspaceId,
    workflowId,
    name: 'Independent copy',
    source: { kind: 'draft' as const },
    idempotencyKey: `duplicate-${randomUUID()}`,
    representationTag: await currentRepresentationTag(
      database,
      workspaceId,
      workflowId,
      actorId,
    ),
  };
}

async function facts(workflowId: string) {
  const rows = await queryAsOwner<{
    workflow: Record<string, unknown>;
    graph: unknown;
    revision: number;
    versions: number;
    runs: number;
    triggers: number;
    outbox: number;
    concurrency: number;
    notifications: number;
    streaks: number;
    receipts: number;
  }>(
    `select to_jsonb(w) workflow,d.graph_json graph,d.revision,
    (select count(*)::int from app.workflow_versions where workflow_id=w.id) versions,
    (select count(*)::int from app.workflow_runs where workflow_id=w.id) runs,
    (select count(*)::int from app.workflow_triggers where workflow_id=w.id) triggers,
    (select count(*)::int from app.outbox_events where aggregate_id=w.id) outbox,
    (select count(*)::int from app.workflow_concurrency_policies where workflow_id=w.id) concurrency,
    (select count(*)::int from app.workflow_failure_notification_policies where workflow_id=w.id) notifications,
    (select count(*)::int from app.workflow_failure_streaks where workflow_id=w.id) streaks,
    (select count(*)::int from app.idempotency_records where resource_id=w.id and operation='workflow.duplicate') receipts
    from app.workflows w join app.workflow_drafts d on d.workspace_id=w.workspace_id and d.workflow_id=w.id
    where w.id=$1`,
    [workflowId],
    workspaceId,
  );
  const row = rows[0];
  if (!row) throw new Error('Expected destination facts');
  return row;
}

async function commandFacts() {
  return queryAsOwner(
    `select
    (select count(*)::int from app.workflows where workspace_id=$1) workflows,
    (select count(*)::int from app.workflow_drafts where workspace_id=$1) drafts,
    (select count(*)::int from app.idempotency_records where workspace_id=$1 and operation='workflow.duplicate') receipts,
    (select count(*)::int from app.audit_events where workspace_id=$1 and action='workflow.duplicated') audits,
    (select count(*)::int from app.outbox_events where workspace_id=$1) outbox`,
    [workspaceId],
    workspaceId,
  );
}

describe('same-workspace workflow duplication through the runtime database role', () => {
  it('replays a completed command before catalog admission while new copies cannot grandfather removed definitions', async () => {
    const current = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      {
        definitionCatalog: {
          schemaVersion: 1,
          definitions: [{ key: 'test.placeholder', version: 1 }],
        },
      },
    );
    const removed = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      {
        definitionCatalog: { schemaVersion: 1, definitions: [] },
      },
    );
    try {
      const original = await source(current, {
        ...emptyGraph,
        nodes: [draftNode('retained-id')],
      });
      const input = await command(original.workflowId, current);
      const copied = await current.duplicateWorkflow(input);
      expect(await removed.duplicateWorkflow(input)).toEqual(copied);
      const before = await commandFacts();
      await expect(
        removed.duplicateWorkflow({
          ...input,
          idempotencyKey: randomUUID(),
          representationTag: await currentRepresentationTag(
            removed,
            workspaceId,
            original.workflowId,
            actorId,
          ),
        }),
      ).rejects.toThrow();
      expect(await commandFacts()).toEqual(before);
    } finally {
      await Promise.all([current.close(), removed.close()]);
    }
  });
  it('preserves nested graph IDs, typed mappings, merge references and dynamic expressions as exact JSON content', async () => {
    const catalog = {
      schemaVersion: 1 as const,
      definitions: [
        { key: 'test.placeholder', version: 1 },
        { key: 'core.foreach', version: 1 },
        { key: 'core.parallel', version: 1 },
        { key: 'core.merge', version: 1 },
      ],
    };
    const database = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      {
        definitionCatalog: catalog,
      },
    );
    const graph = {
      ...emptyGraph,
      settings: { maxRunDurationMs: 1000 },
      nodes: [
        {
          ...draftNode('producer'),
          label: 'Literal producer',
          disabled: true,
          config: { literal: 'producer' },
        },
        {
          ...draftNode('loop'),
          definition: { key: 'core.foreach', version: 1 },
          structured: {
            kind: 'for_each',
            maxIterations: 10,
            maxConcurrency: 2,
            body: {
              ...emptyGraph,
              inputPorts: ['item', 'ordinal'],
              outputPorts: ['result'],
              nodes: [
                {
                  ...draftNode('nested'),
                  inputMappings: {
                    value: {
                      kind: 'structured_input',
                      port: 'item',
                      path: '$',
                    },
                  },
                },
              ],
            },
          },
        },
        {
          ...draftNode('parallel'),
          definition: { key: 'core.parallel', version: 1 },
          config: { branches: ['left', 'right'] },
        },
        {
          ...draftNode('merge'),
          definition: { key: 'core.merge', version: 1 },
          config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
          inputMappings: {
            dynamic: {
              kind: 'expression',
              language: 'jsonata',
              policyVersion: 1,
              expression: '$lookup(nodeOutputs, runInput.stepId).value',
            },
            typed: { kind: 'node_output', nodeId: 'producer', path: '$.value' },
          },
        },
      ],
      edges: [
        {
          id: 'parallel-merge',
          source: { nodeId: 'parallel', port: 'left' },
          target: { nodeId: 'merge', port: 'in' },
        },
      ],
    };
    try {
      const original = await source(database, graph);
      const input = await command(original.workflowId, database);
      const copied = await database.duplicateWorkflow(input);
      expect((await facts(copied.workflowId)).graph).toEqual(graph);
      expect((await facts(original.workflowId)).graph).toEqual(graph);
      await saveCurrentDraft(database, {
        actorId,
        workspaceId,
        workflowId: copied.workflowId,
        expectedRevision: 1,
        graphJson: { ...graph, settings: { maxRunDurationMs: 2000 } },
      });
      expect((await facts(original.workflowId)).graph).toEqual(graph);
      expect((await facts(copied.workflowId)).revision).toBe(2);
    } finally {
      await database.close();
    }
  });

  it('publishes and edits source and copy independently even when every graph ID is shared', async () => {
    const database = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      {
        definitionCatalog: {
          schemaVersion: 1,
          definitions: [{ key: 'test.placeholder', version: 1 }],
        },
      },
    );
    const graph = {
      ...emptyGraph,
      nodes: [draftNode('same-id', { value: 'source' })],
    };
    try {
      const original = await source(database, graph);
      const copied = await database.duplicateWorkflow(
        await command(original.workflowId, database),
      );
      const publish = async (workflowId: string) =>
        database.publishWorkflow({
          actorId,
          workspaceId,
          workflowId,
          representationTag: await currentRepresentationTag(
            database,
            workspaceId,
            workflowId,
            actorId,
          ),
          idempotencyKey: randomUUID(),
          requestHash: 'c'.repeat(64),
        });
      const publications = await Promise.all([
        publish(original.workflowId),
        publish(copied.workflowId),
      ]);
      expect(publications[0].version.id).not.toBe(publications[1].version.id);
      await saveCurrentDraft(database, {
        actorId,
        workspaceId,
        workflowId: copied.workflowId,
        expectedRevision: 1,
        graphJson: {
          ...graph,
          nodes: [draftNode('same-id', { value: 'copy-only' })],
        },
      });
      const next = await publish(copied.workflowId);
      expect(next.version.versionNumber).toBe(2);
      expect((await facts(original.workflowId)).graph).toEqual(graph);
      expect((await facts(original.workflowId)).versions).toBe(1);
      expect((await facts(copied.workflowId)).versions).toBe(2);
    } finally {
      await database.close();
    }
  });
  it('creates exactly one unpublished revision-1 draft with fresh operational defaults and identifier-only recovery', async () => {
    const original = await source();
    await authoring.publishWorkflow({
      actorId,
      workspaceId,
      workflowId: original.workflowId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        original.workflowId,
        actorId,
      ),
      idempotencyKey: randomUUID(),
      requestHash: 'd'.repeat(64),
    });
    await queryAsOwner(
      'insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit) values($1,$2,2)',
      [workspaceId, original.workflowId],
      workspaceId,
    );
    await queryAsOwner(
      'insert into app.workflow_failure_streaks(workspace_id,workflow_id,consecutive_failures) values($1,$2,3)',
      [workspaceId, original.workflowId],
      workspaceId,
    );
    await queryAsOwner(
      'update app.workflows set auto_pause_enabled=false,auto_pause_threshold=9 where workspace_id=$1 and id=$2',
      [workspaceId, original.workflowId],
      workspaceId,
    );
    const input = await command(original.workflowId);
    const before = await commandFacts();
    const copied = await authoring.duplicateWorkflow(input);
    expect(Object.keys(copied)).toEqual(['workflowId']);
    expect(copied.workflowId).not.toBe(original.workflowId);
    const result = await facts(copied.workflowId);
    expect(result.graph).toEqual(emptyGraph);
    expect(result.revision).toBe(1);
    expect(result.workflow).toMatchObject({
      name: input.name,
      name_revision: 1,
      lifecycle_status: 'active',
      lifecycle_revision: 1,
      activation_status: 'inactive',
      published_version_id: null,
      trigger_pause_state: 'none',
      auto_pause_enabled: true,
      auto_pause_threshold: null,
    });
    for (const field of [
      'versions',
      'runs',
      'triggers',
      'outbox',
      'concurrency',
      'notifications',
      'streaks',
    ] as const)
      expect(result[field], field).toBe(0);
    expect(result.receipts).toBe(1);
    expect(await authoring.duplicateWorkflow(input)).toEqual(copied);
    const after = await commandFacts();
    expect(after[0]).toMatchObject({
      workflows: Number(before[0]?.workflows) + 1,
      drafts: Number(before[0]?.drafts) + 1,
      receipts: Number(before[0]?.receipts) + 1,
      audits: Number(before[0]?.audits) + 1,
      outbox: before[0]?.outbox,
    });
    const receipt = await queryAsOwner(
      `select result_ref from app.idempotency_records
      where workspace_id=$1 and resource_id=$2 and operation='workflow.duplicate'`,
      [workspaceId, copied.workflowId],
      workspaceId,
    );
    expect(receipt[0]?.result_ref).toEqual(copied);
  });

  it('checks draft tags authoritatively but replays the original command after source saves and process restart', async () => {
    const original = await source();
    const input = await command(original.workflowId);
    const copied = await authoring.duplicateWorkflow(input);
    await saveCurrentDraft(authoring, {
      actorId,
      workspaceId,
      workflowId: original.workflowId,
      expectedRevision: 1,
      graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 1000 } },
    });
    const restarted = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    );
    try {
      // Discarding the first response models a lost response; restart uses only the durable command receipt.
      expect(await restarted.duplicateWorkflow(input)).toEqual(copied);
      expect((await facts(copied.workflowId)).graph).toEqual(emptyGraph);
      await expect(
        restarted.duplicateWorkflow({ ...input, idempotencyKey: randomUUID() }),
      ).rejects.toBeInstanceOf(WorkflowRevisionConflictError);
      await expect(
        restarted.duplicateWorkflow({ ...input, name: 'Changed command' }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      await expect(
        restarted.duplicateWorkflow({
          ...input,
          source: { kind: 'version', versionId: otherVersionId },
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    } finally {
      await restarted.close();
    }
  });

  it('selects the exact immutable version and rejects versions belonging to another source or workspace', async () => {
    const original = await source();
    const published = await authoring.publishWorkflow({
      actorId,
      workspaceId,
      workflowId: original.workflowId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        original.workflowId,
        actorId,
      ),
      idempotencyKey: randomUUID(),
      requestHash: 'a'.repeat(64),
    });
    await saveCurrentDraft(authoring, {
      actorId,
      workspaceId,
      workflowId: original.workflowId,
      expectedRevision: 1,
      graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 2000 } },
    });
    const input = {
      actorId,
      workspaceId,
      workflowId: original.workflowId,
      name: 'Version copy',
      source: { kind: 'version' as const, versionId: published.version.id },
      idempotencyKey: randomUUID(),
    };
    const copied = await authoring.duplicateWorkflow(input);
    expect((await facts(copied.workflowId)).graph).toEqual(emptyGraph);
    const before = await commandFacts();
    await expect(
      authoring.duplicateWorkflow({
        ...input,
        idempotencyKey: randomUUID(),
        source: { kind: 'version', versionId: otherVersionId },
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(
      authoring.duplicateWorkflow({
        ...input,
        idempotencyKey: randomUUID(),
        workflowId: otherWorkflowId,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(
      authoring.duplicateWorkflow({
        ...input,
        idempotencyKey: randomUUID(),
        workspaceId: otherWorkspaceId,
        actorId: otherActorId,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    expect(await commandFacts()).toEqual(before);
  });

  it('serializes simultaneous identical keys and admits different keys as independent destinations', async () => {
    const original = await source();
    const input = await command(original.workflowId);
    const copies = await Promise.all(
      Array.from({ length: 6 }, () => authoring.duplicateWorkflow(input)),
    );
    expect(new Set(copies.map((copy) => copy.workflowId)).size).toBe(1);
    const independent = await Promise.all(
      Array.from({ length: 4 }, () =>
        authoring.duplicateWorkflow({ ...input, idempotencyKey: randomUUID() }),
      ),
    );
    expect(
      new Set([...copies, ...independent].map((copy) => copy.workflowId)).size,
    ).toBe(5);
  });

  it('allows the same opaque key for different source scopes but conflicts concurrent changed input in one scope', async () => {
    const first = await source(),
      second = await source();
    const key = randomUUID();
    const a = { ...(await command(first.workflowId)), idempotencyKey: key };
    const b = { ...(await command(second.workflowId)), idempotencyKey: key };
    const copies = await Promise.all([
      authoring.duplicateWorkflow(a),
      authoring.duplicateWorkflow(b),
    ]);
    expect(copies[0].workflowId).not.toBe(copies[1].workflowId);
    const input = { ...a, idempotencyKey: randomUUID() };
    const before = await commandFacts();
    const settled = await Promise.allSettled([
      authoring.duplicateWorkflow(input),
      authoring.duplicateWorkflow({ ...input, name: 'Conflicting command' }),
    ]);
    expect(
      settled.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = settled.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(IdempotencyConflictError);
    expect((await commandFacts())[0]?.workflows).toBe(
      Number(before[0]?.workflows) + 1,
    );
  });

  it.each([
    'claim',
    'source',
    'workflow',
    'draft',
    'audit',
    'idempotency',
  ] as const)(
    'rolls back the entire command after an injected %s failure',
    async (step) => {
      const original = await source();
      const input = await command(original.workflowId);
      const before = await commandFacts();
      const faulting = createWorkflowAuthoringDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
        {
          testHooks: {
            afterDuplicateStep: (reached) =>
              reached === step
                ? Promise.reject(new Error(`injected-${step}`))
                : Promise.resolve(),
          },
        },
      );
      try {
        await expect(faulting.duplicateWorkflow(input)).rejects.toThrow(
          `injected-${step}`,
        );
      } finally {
        await faulting.close();
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
    const entered = deferred(),
      release = deferred();
    const copying = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      {
        testHooks: {
          afterDuplicateStep: async (step) => {
            if (step === 'source') {
              entered.resolve();
              await release.promise;
            }
          },
        },
      },
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
        entered.promise,
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
      release.resolve();
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
      release: release.resolve,
      operations: [copy, save],
      close: [() => copying.close(), () => saving.close()],
    });
  });

  it('holds authority, source and catalog locks while concurrent archive, membership suspension and release changes wait', async () => {
    for (const race of ['archive', 'membership'] as const) {
      const original = await source();
      const entered = deferred(),
        release = deferred();
      const copying = createWorkflowAuthoringDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
        {
          testHooks: {
            afterDuplicateStep: async (step) => {
              if (step === 'source') {
                entered.resolve();
                await release.promise;
              }
            },
          },
        },
      );
      const input = await command(original.workflowId, copying);
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
          entered.promise,
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
        release.resolve();
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
        release: release.resolve,
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

  it('rolls back a failure between the workflow and draft inserts', async () => {
    const original = await source();
    const input = {
      ...(await command(original.workflowId)),
      name: 'Fault between workflow and draft',
    };
    await executeAsOwner(`create function app.test_duplicate_draft_failure() returns trigger
      language plpgsql as $$ begin
        if exists(select 1 from app.workflows where id=new.workflow_id and name='Fault between workflow and draft')
          then raise exception 'injected-mid-function'; end if;
        return new;
      end $$;
      create trigger test_duplicate_draft_failure before insert on app.workflow_drafts
      for each row execute function app.test_duplicate_draft_failure()`);
    try {
      const before = await commandFacts();
      await expect(authoring.duplicateWorkflow(input)).rejects.toThrow(
        'injected-mid-function',
      );
      expect(await commandFacts()).toEqual(before);
    } finally {
      await executeAsOwner(
        'drop trigger test_duplicate_draft_failure on app.workflow_drafts; drop function app.test_duplicate_draft_failure()',
      );
    }
    expect(await authoring.duplicateWorkflow(input)).toHaveProperty(
      'workflowId',
    );
  });

  it('retains same-workspace connection references without reading or duplicating secrets and rejects foreign refs in arbitrary slots', async () => {
    const connections = createConnectionDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
    );
    const database = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      {
        definitionCatalog: {
          schemaVersion: 1,
          definitions: [
            { key: 'test.placeholder', version: 1 },
            { key: 'core.foreach', version: 1 },
          ],
        },
      },
    );
    const connectionId = randomUUID(),
      foreignId = randomUUID();
    const create = async (id: string, workspace: string, actor: string) =>
      connections.createConnection({
        workspaceId: workspace,
        actorId: actor,
        connectionId: id,
        secretVersionId: randomUUID(),
        providerKey: 'http',
        name: 'Reference only',
        authType: CONNECTION_AUTH_TYPE.httpHeaders,
        idempotencyKey: randomUUID(),
        requestHash: createHash('sha256').update(id).digest('hex'),
        sealed: {
          schemaVersion: 1,
          kmsKeyReference: 'arn:aws:kms:region:account:key/duplication',
          encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
          ciphertext: Buffer.from('never-copy-secret').toString('base64url'),
          nonce: Buffer.alloc(12, 2).toString('base64url'),
          tag: Buffer.alloc(16, 3).toString('base64url'),
        },
      });
    try {
      await create(connectionId, workspaceId, actorId);
      await create(foreignId, otherWorkspaceId, otherActorId);
      const graph = {
        ...emptyGraph,
        nodes: [
          { ...draftNode('ref'), connectionRefs: { arbitrary: connectionId } },
        ],
      };
      const original = await source(database, graph);
      const input = await command(original.workflowId, database);
      const secrets = await queryAsOwner(
        'select id,ciphertext from app.connection_secret_versions order by id',
        [],
        workspaceId,
      );
      expect(secrets).toHaveLength(1);
      const copied = await database.duplicateWorkflow(input);
      expect((await facts(copied.workflowId)).graph).toEqual(graph);
      expect(
        await queryAsOwner(
          'select id,ciphertext from app.connection_secret_versions order by id',
          [],
          workspaceId,
        ),
      ).toEqual(secrets);
      await connections.revokeConnection({
        actorId,
        workspaceId,
        connectionId,
      });
      const revokedCopy = await database.duplicateWorkflow({
        ...input,
        idempotencyKey: randomUUID(),
      });
      expect((await facts(revokedCopy.workflowId)).graph).toEqual(graph);
      expect(
        await queryAsOwner(
          'select status from app.connections where id=$1',
          [connectionId],
          workspaceId,
        ),
      ).toEqual([{ status: 'revoked' }]);
      // A forged persisted reference is an owner-controlled corruption fixture, not client graph admission.
      await queryAsOwner(
        'update app.workflow_drafts set graph_json=$2 where workflow_id=$1',
        [
          original.workflowId,
          JSON.stringify({
            ...graph,
            nodes: [
              {
                ...draftNode('ref'),
                connectionRefs: { arbitrary: foreignId },
              },
            ],
          }),
        ],
        workspaceId,
      );
      const foreign = await command(original.workflowId, database);
      const before = await commandFacts();
      await expect(database.duplicateWorkflow(foreign)).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
      expect(await commandFacts()).toEqual(before);
      const nestedForeign = {
        ...emptyGraph,
        nodes: [
          {
            ...draftNode('loop-ref'),
            definition: { key: 'core.foreach', version: 1 },
            structured: {
              kind: 'for_each',
              maxIterations: 10,
              maxConcurrency: 1,
              body: {
                ...emptyGraph,
                inputPorts: ['item', 'ordinal'],
                outputPorts: ['result'],
                nodes: [
                  {
                    ...draftNode('nested-ref'),
                    connectionRefs: { arbitrary: foreignId },
                  },
                ],
              },
            },
          },
        ],
      };
      await queryAsOwner(
        'update app.workflow_drafts set graph_json=$2 where workflow_id=$1',
        [original.workflowId, JSON.stringify(nestedForeign)],
        workspaceId,
      );
      await expect(
        database.duplicateWorkflow(
          await command(original.workflowId, database),
        ),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
      expect(await commandFacts()).toEqual(before);
      expect(await database.duplicateWorkflow(input)).toEqual(copied);
    } finally {
      await Promise.all([database.close(), connections.close()]);
    }
  });

  it('copies a template origin as inherited and shows it only to members of the workspace', async () => {
    const original = await source();
    const origin = {
      schemaVersion: 1,
      templateId: 'controlled-http-notification',
      templateVersion: 1,
      baseManifestDigest: 'a'.repeat(64),
      creationCommandDigest: 'b'.repeat(64),
      derivation: 'direct',
    };
    await queryAsOwner(
      'insert into app.workflow_template_origins (workspace_id, workflow_id, origin) values ($1, $2, $3::jsonb)',
      [workspaceId, original.workflowId, JSON.stringify(origin)],
      workspaceId,
    );
    const input = await command(original.workflowId);
    const copy = await authoring.duplicateWorkflow(input);
    expect(await authoring.duplicateWorkflow(input)).toEqual(copy);
    expect(
      await authoring.getWorkflowWithTemplateOrigin(
        workspaceId,
        copy.workflowId,
        actorId,
      ),
    ).toMatchObject({ templateOrigin: { ...origin, derivation: 'inherited' } });
    expect(
      await authoring.getWorkflowWithTemplateOrigin(
        workspaceId,
        original.workflowId,
        actorId,
      ),
    ).toMatchObject({ templateOrigin: origin });
    const copyOfCopy = await authoring.duplicateWorkflow(
      await command(copy.workflowId),
    );
    expect(
      await authoring.getWorkflowWithTemplateOrigin(
        workspaceId,
        copyOfCopy.workflowId,
        actorId,
      ),
    ).toMatchObject({ templateOrigin: { ...origin, derivation: 'inherited' } });
    await expect(
      authoring.getWorkflowWithTemplateOrigin(
        workspaceId,
        copy.workflowId,
        otherActorId,
      ),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it('removes an expired duplicate receipt without erasing either workflow and admits a new copy after expiry', async () => {
    const original = await source();
    const input = await command(original.workflowId);
    const copied = await authoring.duplicateWorkflow(input);
    await queryAsOwner(
      "update app.idempotency_records set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and operation='workflow.duplicate' and resource_id=$2",
      [workspaceId, copied.workflowId],
      workspaceId,
    );
    const reaped = await enforceTestRetention();
    expect(reaped.idempotency_records).toBeGreaterThanOrEqual(1);
    expect((await facts(original.workflowId)).revision).toBe(1);
    expect((await facts(copied.workflowId)).revision).toBe(1);
    expect((await facts(copied.workflowId)).receipts).toBe(0);
    const afterExpiry = await authoring.duplicateWorkflow(input);
    expect(afterExpiry.workflowId).not.toBe(copied.workflowId);
  });

  it('reaps expired source-scoped duplication receipts, then erases them through bounded workspace purge', async () => {
    const workspace = await identity.createWorkspaceWithOwner({
      id: randomUUID(),
      name: 'Duplication hold/purge',
      slug: `duplicate-purge-${randomUUID()}`,
      ownerUserId: actorId,
      idempotencyKey: randomUUID(),
    });
    const scopedWorkspace = workspace.id;
    const original = await authoring.createWorkflow({
      actorId,
      workspaceId: scopedWorkspace,
      name: 'Purge source',
      emptyGraph,
      idempotencyKey: randomUUID(),
    });
    const input = {
      actorId,
      workspaceId: scopedWorkspace,
      workflowId: original.workflowId,
      name: 'Purge copy',
      source: { kind: 'draft' as const },
      representationTag: await currentRepresentationTag(
        authoring,
        scopedWorkspace,
        original.workflowId,
        actorId,
      ),
      idempotencyKey: randomUUID(),
    };
    const copied = await authoring.duplicateWorkflow(input);
    await queryAsOwner(
      "update app.idempotency_records set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and operation='workflow.duplicate'",
      [scopedWorkspace],
      scopedWorkspace,
    );
    await enforceTestRetention();
    expect(
      await queryAsOwner(
        "select id from app.idempotency_records where workspace_id=$1 and operation='workflow.duplicate'",
        [scopedWorkspace],
        scopedWorkspace,
      ),
    ).toEqual([]);
    const fresh = await authoring.duplicateWorkflow(input);
    expect(fresh.workflowId).not.toBe(copied.workflowId);
    await purgeTestWorkspace(scopedWorkspace);
    expect(
      await queryAsOwner(
        `select
      (select count(*)::int from app.idempotency_records where workspace_id=$1) receipts,
      (select count(*)::int from app.workflows where workspace_id=$1) workflows,
      (select count(*)::int from app.workflow_drafts where workspace_id=$1) drafts`,
        [scopedWorkspace],
        scopedWorkspace,
      ),
    ).toEqual([{ receipts: 0, workflows: 0, drafts: 0 }]);
    await expect(authoring.duplicateWorkflow(input)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
  });
});
