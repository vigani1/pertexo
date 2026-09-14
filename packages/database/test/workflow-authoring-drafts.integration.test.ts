import { describe, expect, it } from 'vitest';
import { workflowRetainedExecutableChecksum } from '@pertexo/workflow-model/graph';

import {
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
  actorId,
  apiPool,
  authoring,
  currentRepresentationTag,
  draftNode,
  emptyGraph,
  finishTransactionClient,
  otherActorId,
  otherVersionId,
  otherWorkflowId,
  otherWorkspaceId,
  queryAsOwner,
  randomUUID,
  saveCurrentDraft,
  workerPool,
  workflowId,
  workspaceId,
} from './support/workflow-authoring.integration.support.js';

describe('workflow draft persistence', () => {
  it('requires the full current representation tag while revision CAS remains authoritative', async () => {
    const created = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-save-tag-authority',
      name: 'Save tag authority',
      workspaceId,
    });
    const input = {
      actorId,
      expectedRevision: 1,
      graphJson: emptyGraph,
      workflowId: created.workflowId,
      workspaceId,
    } as const;
    const currentTag = await currentRepresentationTag(
      authoring,
      workspaceId,
      created.workflowId,
      actorId,
    );

    await expect(
      authoring.saveDraft({ ...input, representationTag: 'not-a-draft-tag' }),
    ).rejects.toMatchObject({ name: 'ZodError' });

    const wrongTag = `"draft-v1.${'A'.repeat(43)}"`;
    await expect(
      authoring.saveDraft({ ...input, representationTag: wrongTag }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'WorkflowRevisionConflictError',
        currentRevision: 1,
        currentEtag: currentTag,
      }),
    );
    await expect(
      authoring.getDraft(workspaceId, created.workflowId, actorId),
    ).resolves.toMatchObject({ revision: 1 });

    const saved = await authoring.saveDraft({
      ...input,
      representationTag: currentTag,
    });
    expect(saved.revision).toBe(2);
    const savedTag = await currentRepresentationTag(
      authoring,
      workspaceId,
      created.workflowId,
      actorId,
    );
    await expect(
      authoring.saveDraft({ ...input, representationTag: currentTag }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'WorkflowRevisionConflictError',
        currentRevision: 2,
        currentEtag: savedTag,
      }),
    );
    await expect(
      authoring.saveDraft({
        ...input,
        representationTag: currentTag,
        workflowId: otherWorkflowId,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it('atomically creates a workflow with exactly one revision-1 draft', async () => {
    let workflowId = '';
    const createInput = {
      actorId,
      emptyGraph,
      idempotencyKey: 'create-first-workflow',
      name: 'First workflow',
      workspaceId,
    } as const;
    const created = await authoring.createWorkflow(createInput);
    workflowId = created.workflowId;
    expect(created).toMatchObject({
      workflow: { id: workflowId, name: 'First workflow' },
      draft: { workflowId, revision: 1, schemaVersion: 1, workspaceId },
    });
    await expect(
      authoring.getDraft(workspaceId, workflowId, actorId),
    ).resolves.toMatchObject({ revision: 1, schemaVersion: 1, workspaceId });
    await expect(authoring.createWorkflow(createInput)).resolves.toMatchObject({
      workflowId,
    });
    await expect(
      authoring.createWorkflow({ ...createInput, name: 'Changed request' }),
    ).rejects.toBeInstanceOf(WorkflowIdempotencyConflictError);
    const workflows = await authoring.listWorkflows({ workspaceId, actorId });
    expect(workflows.items.some(({ id }) => id === workflowId)).toBe(true);

    const concurrentInput = {
      ...createInput,
      idempotencyKey: 'create-concurrent-workflow',
      name: 'Concurrent workflow',
    };
    const concurrent = await Promise.all([
      authoring.createWorkflow(concurrentInput),
      authoring.createWorkflow(concurrentInput),
    ]);
    expect(concurrent[0].workflowId).toBe(concurrent[1].workflowId);
    const listed = await authoring.listWorkflows({
      workspaceId,
      actorId,
      limit: 2,
    });
    expect(Array.isArray(listed.items)).toBe(true);
    const firstPage = await authoring.listWorkflows({
      workspaceId,
      actorId,
      limit: 1,
    });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeDefined();
    const firstWorkflow = firstPage.items[0];
    expect(firstWorkflow).toBeDefined();
    if (firstWorkflow === undefined) throw new Error('Missing first page row');
    const rename = await apiPool.connect();
    let renameOpen = false;
    let renameError: unknown;
    try {
      await rename.query('begin');
      renameOpen = true;
      await rename.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await rename.query(
        "update app.workflows set name = 'Renamed between pages' where id = $1",
        [firstWorkflow.id],
      );
      await rename.query('commit');
      renameOpen = false;
    } catch (error: unknown) {
      renameError = error;
    }
    await finishTransactionClient(rename, {
      label: 'Between-pages workflow rename',
      primaryError: renameError,
      transactionOpen: renameOpen,
    });
    const secondPage = await authoring.listWorkflows({
      workspaceId,
      actorId,
      after: { createdAt: firstWorkflow.createdAt, id: firstWorkflow.id },
      limit: 10,
    });
    expect(secondPage.items.map((workflow) => workflow.id)).not.toContain(
      firstWorkflow.id,
    );

    const grants = await workerPool.query<{ can_read: boolean }>(
      "select has_table_privilege(current_user, 'app.workflow_versions', 'SELECT') as can_read",
    );
    expect(grants.rows[0]?.can_read).toBe(false);

    await expect(
      authoring.getDraft(otherWorkspaceId, otherWorkflowId, actorId),
    ).rejects.toThrow('Workflow is not visible');

    const api = await apiPool.connect();
    let apiOpen = false;
    let apiError: unknown;
    try {
      const absent = await api.query<{ drafts: string }>(
        `select (
          (select count(*) from app.workflow_drafts) +
          (select count(*) from app.workflow_versions) +
          (select count(*) from app.audit_events) +
          (select count(*) from app.idempotency_records) +
          (select count(*) from app.outbox_events)
        )::text as drafts`,
      );
      expect(absent.rows[0]?.drafts).toBe('0');
      await api.query('begin');
      apiOpen = true;
      await api.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      const crossWorkspace = await api.query<{ drafts: string }>(
        `select (
          (select count(*) from app.workflow_drafts where workflow_id = $1) +
          (select count(*) from app.workflow_versions where workflow_id = $1) +
          (select count(*) from app.audit_events where target_id = $1) +
          (select count(*) from app.idempotency_records where resource_id = $1) +
          (select count(*) from app.outbox_events where aggregate_id = $1)
        )::text as drafts`,
        [otherWorkflowId],
      );
      expect(crossWorkspace.rows[0]?.drafts).toBe('0');
      await expect(
        api.query(
          `insert into app.workflow_drafts
             (workflow_id, workspace_id, revision, schema_version, graph_json, updated_by)
           values ($1, $2, 1, 1, '{}'::jsonb, $3)`,
          [randomUUID(), workspaceId, actorId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await api.query('rollback');
      apiOpen = false;
      await api.query('begin');
      apiOpen = true;
      await api.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await expect(
        api.query('delete from app.workflow_drafts where workflow_id = $1', [
          workflowId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await api.query('rollback');
      apiOpen = false;
    } catch (error: unknown) {
      apiError = error;
    }
    await finishTransactionClient(api, {
      label: 'Workflow draft RLS proof',
      primaryError: apiError,
      transactionOpen: apiOpen,
    });
  });

  it('rejects absent-context and cross-tenant writes for every publication relation', async () => {
    const attempts: readonly (readonly [string, unknown[]])[] = [
      [
        `insert into app.workflow_versions
          (id, workspace_id, workflow_id, version_number, schema_version,
           graph_json, checksum, published_by)
         values ($1, $2, $3, 999, 1, '{}'::jsonb, $4, $5)`,
        [
          randomUUID(),
          otherWorkspaceId,
          otherWorkflowId,
          `wf:v1:sha256:${'1'.repeat(64)}`,
          otherActorId,
        ],
      ],
      [
        `insert into app.audit_events
          (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1, $2, $3, 'workflow.published', 'workflow', $4, '{}'::jsonb)`,
        [randomUUID(), otherWorkspaceId, otherActorId, otherWorkflowId],
      ],
      [
        `insert into app.idempotency_records
          (id, workspace_id, operation, scope, key_hash, request_hash,
           status, resource_id, result_ref)
         values ($1, $2, 'workflow.publish', $3, $4, $5,
           'in_progress', $6, '{}'::jsonb)`,
        [
          randomUUID(),
          otherWorkspaceId,
          `${otherActorId}:${otherWorkflowId}`,
          '2'.repeat(64),
          '3'.repeat(64),
          otherWorkflowId,
        ],
      ],
      [
        `insert into app.outbox_events
          (id, workspace_id, job_name, schema_version, aggregate_type,
           aggregate_id, payload, payload_checksum)
         values ($1, $2, 'reconcile-workflow-triggers', 1, 'workflow',
           $3, '{}'::jsonb, $4)`,
        [randomUUID(), otherWorkspaceId, otherWorkflowId, '4'.repeat(64)],
      ],
    ];
    for (const [statement, parameters] of attempts) {
      const client = await apiPool.connect();
      let transactionOpen = false;
      let primaryError: unknown;
      try {
        await client.query('begin');
        transactionOpen = true;
        await client.query("select set_config('app.workspace_id', $1, true)", [
          workspaceId,
        ]);
        await expect(client.query(statement, parameters)).rejects.toMatchObject(
          { code: '42501' },
        );
        await client.query('rollback');
        transactionOpen = false;
      } catch (error: unknown) {
        primaryError = error;
      }
      await finishTransactionClient(client, {
        label: 'Cross-tenant publication relation proof',
        primaryError,
        transactionOpen,
      });
    }

    const absent = await apiPool.connect();
    try {
      await expect(
        absent.query(
          `insert into app.audit_events
            (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
           values ($1, $2, $3, 'workflow.published', 'workflow', $4, '{}'::jsonb)`,
          [randomUUID(), workspaceId, actorId, workflowId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      absent.release();
    }
    expect(otherVersionId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('accepts the exact compact graph limit and rejects one byte over before insert', async () => {
    const graphEnvelope = {
      ...emptyGraph,
      nodes: [draftNode('large', { padding: '' })],
    };
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify(graphEnvelope),
      'utf8',
    );
    const exactGraph = {
      ...graphEnvelope,
      nodes: [
        draftNode('large', {
          padding: 'x'.repeat(1_048_576 - envelopeBytes),
        }),
      ],
    };
    const exactCreated = await authoring.createWorkflow({
      actorId,
      emptyGraph: exactGraph,
      idempotencyKey: 'create-exact-limit',
      name: 'Exact limit',
      workspaceId,
    });
    expect(exactCreated.workflowId).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(
      authoring.createWorkflow({
        actorId,
        emptyGraph: {
          ...exactGraph,
          nodes: [
            draftNode('large', {
              padding: `${String(exactGraph.nodes[0]?.config.padding)}x`,
            }),
          ],
        },
        idempotencyKey: 'create-over-limit',
        name: 'Over limit',
        workspaceId,
      }),
    ).rejects.toThrow('graph bytes exceed the graph limit');
  });

  it('uses the workflow-model contract at every draft persistence boundary', async () => {
    await expect(
      authoring.createWorkflow({
        actorId,
        emptyGraph: {},
        idempotencyKey: 'create-invalid-graph',
        name: 'Invalid graph',
        workspaceId,
      }),
    ).rejects.toThrow();
    await expect(
      saveCurrentDraft(authoring, {
        actorId,
        expectedRevision: 1,
        graphJson: { ...emptyGraph, unknown: true },
        workflowId,
        workspaceId,
      }),
    ).rejects.toThrow();

    const corrupted = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-corrupt-read-proof',
      name: 'Corrupt read proof',
      workspaceId,
    });
    const api = await apiPool.connect();
    let transactionOpen = false;
    let primaryError: unknown;
    try {
      await api.query('begin');
      transactionOpen = true;
      await api.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await api.query(
        "update app.workflow_drafts set graph_json = '{}'::jsonb where workflow_id = $1",
        [corrupted.workflowId],
      );
      await api.query('commit');
      transactionOpen = false;
    } catch (error: unknown) {
      primaryError = error;
    }
    await finishTransactionClient(api, {
      label: 'Corrupt draft fixture update',
      primaryError,
      transactionOpen,
    });
    await expect(
      authoring.getDraft(workspaceId, corrupted.workflowId, actorId),
    ).rejects.toThrow();
  });

  it.each(['first', 'middle', 'last'] as const)(
    'rejects a corrupt %s retained version before publication mutation',
    async (position) => {
      const corrupted = await authoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: `create-corrupt-version-${position}`,
        name: `Corrupt version ${position}`,
        workspaceId,
      });
      const graphs = [
        emptyGraph,
        { ...emptyGraph, settings: { maxRunDurationMs: 1_000 } },
        { ...emptyGraph, settings: { maxRunDurationMs: 2_000 } },
      ] as const;
      const corruptIndex =
        position === 'first' ? 0 : position === 'middle' ? 1 : 2;
      const versions = graphs.map(() => randomUUID());
      for (const [index, graph] of graphs.entries())
        await queryAsOwner(
          `insert into app.workflow_versions
             (id,workspace_id,workflow_id,version_number,schema_version,
              graph_json,checksum,published_by)
           values($1,$2,$3,$4,1,$5::jsonb,$6,$7)
           returning id`,
          [
            versions[index],
            workspaceId,
            corrupted.workflowId,
            index + 1,
            JSON.stringify(graph),
            index === corruptIndex
              ? `wf:v1:sha256:${'f'.repeat(64)}`
              : workflowRetainedExecutableChecksum(graph),
            actorId,
          ],
          workspaceId,
        );
      const versionId = versions[corruptIndex];
      if (versionId === undefined)
        throw new Error('Corruption target is missing');

      await expect(
        authoring.getVersion(
          workspaceId,
          corrupted.workflowId,
          versionId,
          actorId,
        ),
      ).rejects.toThrow('checksum does not match its graph');
      await expect(
        authoring.publishWorkflow({
          actorId,
          representationTag: await currentRepresentationTag(
            authoring,
            workspaceId,
            corrupted.workflowId,
            actorId,
          ),
          idempotencyKey: `publish-after-corrupt-version-${position}`,
          requestHash: 'f'.repeat(64),
          workflowId: corrupted.workflowId,
          workspaceId,
        }),
      ).rejects.toThrow('checksum does not match its graph');

      const durableState = await queryAsOwner<{
        audits: string;
        outbox: string;
        published_version_id: string | null;
        versions: string;
      }>(
        `select workflow.published_version_id,
              (select count(*) from app.workflow_versions version
               where version.workflow_id = workflow.id)::text as versions,
              (select count(*) from app.audit_events audit
               where audit.target_id = workflow.id
                 and audit.action = 'workflow.published')::text as audits,
              (select count(*) from app.outbox_events event
               where event.aggregate_id = workflow.id
                 and event.job_name = 'reconcile-workflow-triggers')::text as outbox
       from app.workflows workflow where workflow.id = $1`,
        [corrupted.workflowId],
        workspaceId,
      );
      expect(durableState[0]).toEqual({
        audits: '0',
        outbox: '0',
        published_version_id: null,
        versions: '3',
      });
    },
  );
});
