import { describe, expect, it } from 'vitest';

import {
  WorkflowPublishIdempotencyConflictError,
  actorId,
  apiPool,
  apiUrl,
  authoring,
  createHash,
  createWorkflowAuthoringDatabase,
  currentRepresentationTag,
  draftNode,
  emptyGraph,
  ownerPool,
  parseDatabaseConfig,
  randomUUID,
  workflowDraftRepresentationTag,
  workflowId,
  workspaceId,
} from './support/workflow-authoring.integration.support.js';

describe('workflow publication atomicity', () => {
  it('rolls back every material publication step and locked-validator failure', async () => {
    const steps = [
      'version',
      'integration_usage',
      'trigger_projection',
      'pointer',
      'outbox',
      'audit',
      'idempotency',
    ] as const;
    for (const step of steps) {
      const created = await authoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: `create-rollback-${step}`,
        name: `Rollback ${step}`,
        workspaceId,
      });
      const faulting = createWorkflowAuthoringDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
        {
          testHooks: {
            afterPublishStep: (reached) =>
              reached === step
                ? Promise.reject(new Error(`injected-${step}`))
                : Promise.resolve(),
          },
        },
      );
      try {
        const representationTag = await currentRepresentationTag(
          authoring,
          workspaceId,
          created.workflowId,
          actorId,
        );
        await expect(
          faulting.publishWorkflow({
            actorId,
            representationTag,
            idempotencyKey: `publish-rollback-${step}`,
            requestHash: createHash('sha256').update(step).digest('hex'),
            workflowId: created.workflowId,
            workspaceId,
          }),
        ).rejects.toThrow(`injected-${step}`);
      } finally {
        await faulting.close();
      }
      const proof = await apiPool.connect();
      try {
        await proof.query('begin');
        await proof.query("select set_config('app.workspace_id', $1, true)", [
          workspaceId,
        ]);
        const rows = await proof.query<{
          audits: string;
          commands: string;
          outbox: string;
          pointer: string | null;
          usage: string;
          triggers: string;
          versions: string;
        }>(
          `select
            (select count(*) from app.workflow_versions where workflow_id = $1)::text versions,
            (select count(*) from app.audit_events where target_id = $1 and action = 'workflow.published')::text audits,
            (select count(*) from app.outbox_events where aggregate_id = $1 and job_name = 'reconcile-workflow-triggers')::text outbox,
            (select count(*) from app.idempotency_records where resource_id = $1 and operation = 'workflow.publish')::text commands,
            (select count(*) from app.workflow_integration_usage usage join app.workflow_versions version on version.id = usage.workflow_version_id where version.workflow_id = $1)::text usage,
            (select count(*) from app.workflow_triggers trigger where trigger.workflow_id = $1)::text triggers,
            (select published_version_id::text from app.workflows where id = $1) pointer`,
          [created.workflowId],
        );
        expect(rows.rows[0]).toEqual({
          audits: '0',
          commands: '0',
          outbox: '0',
          pointer: null,
          usage: '0',
          triggers: '0',
          versions: '0',
        });
        await proof.query('rollback');
      } finally {
        proof.release();
      }
    }

    const invalid = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-validator-failure',
      name: 'Validator failure',
      workspaceId,
    });
    await authoring.saveDraft({
      actorId,
      expectedRevision: 1,
      graphJson: { ...emptyGraph, nodes: [draftNode('unknown-definition')] },
      workflowId: invalid.workflowId,
      workspaceId,
    });
    await expect(
      authoring.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          authoring,
          workspaceId,
          invalid.workflowId,
          actorId,
        ),
        idempotencyKey: 'publish-validator-failure',
        requestHash: '8'.repeat(64),
        workflowId: invalid.workflowId,
        workspaceId,
      }),
    ).rejects.toThrow('workflow graph failed semantic validation');
    await expect(
      authoring.getVersion(
        workspaceId,
        invalid.workflowId,
        randomUUID(),
        actorId,
      ),
    ).resolves.toBeNull();
  });

  it('publishes atomically, replays exactly, and rejects changed key reuse', async () => {
    const draft = await authoring.getDraft(workspaceId, workflowId, actorId);
    expect(draft).not.toBeNull();
    if (draft === null) throw new Error('Expected workflow draft');
    const representationTag = workflowDraftRepresentationTag({
      workflowId,
      revision: draft.revision,
      graph: draft.graphJson,
      compatibilityFingerprint: draft.compatibility.fingerprint,
    });
    const input = {
      actorId,
      representationTag,
      idempotencyKey: 'publish-proof',
      requestHash: 'a'.repeat(64),
      workflowId,
      workspaceId,
    } as const;
    await expect(
      authoring.publishWorkflow({
        ...input,
        idempotencyKey: 'publish-rollback',
        requestHash: 'e'.repeat(64),
        traceId: 'x'.repeat(129),
      }),
    ).rejects.toMatchObject({ code: '22001' });

    const publications = await Promise.all([
      authoring.publishWorkflow(input),
      authoring.publishWorkflow(input),
    ]);
    expect(publications.map((result) => result.replayed).sort()).toEqual([
      false,
      true,
    ]);
    const published = publications[0];
    const saved = await authoring.saveDraft({
      actorId,
      expectedRevision: draft.revision,
      graphJson: draft.graphJson,
      workflowId,
      workspaceId,
    });
    await expect(authoring.publishWorkflow(input)).resolves.toMatchObject({
      replayed: true,
      version: { id: published.version.id },
    });
    await expect(
      authoring.publishWorkflow({
        ...input,
        idempotencyKey: 'publish-stale-distinct',
        requestHash: '9'.repeat(64),
      }),
    ).rejects.toMatchObject({ currentRevision: saved.revision });
    const currentPublications = await Promise.all([
      authoring.publishWorkflow({
        ...input,
        representationTag: workflowDraftRepresentationTag({
          workflowId,
          revision: saved.revision,
          graph: saved.graphJson,
          compatibilityFingerprint: saved.compatibility.fingerprint,
        }),
        idempotencyKey: 'publish-current-distinct-a',
        requestHash: 'd'.repeat(64),
      }),
      authoring.publishWorkflow({
        ...input,
        representationTag: workflowDraftRepresentationTag({
          workflowId,
          revision: saved.revision,
          graph: saved.graphJson,
          compatibilityFingerprint: saved.compatibility.fingerprint,
        }),
        idempotencyKey: 'publish-current-distinct-b',
        requestHash: 'f'.repeat(64),
      }),
    ]);
    expect(currentPublications).toEqual([
      expect.objectContaining({ replayed: false, reused: true }),
      expect.objectContaining({ replayed: false, reused: true }),
    ]);
    await expect(
      authoring.publishWorkflow({ ...input, requestHash: 'c'.repeat(64) }),
    ).rejects.toBeInstanceOf(WorkflowPublishIdempotencyConflictError);

    const owner = await ownerPool.connect();
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await expect(
        owner.query(
          'update app.workflow_versions set version_number = 99 where id = $1',
          [published.version.id],
        ),
      ).rejects.toMatchObject({ code: '55000' });
      await owner.query('rollback');
    } finally {
      owner.release();
    }

    const api = await apiPool.connect();
    try {
      await api.query('begin');
      await api.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      const facts = await api.query<{
        audits: string;
        outbox: string;
        versions: string;
      }>(
        `select
        (select count(*) from app.audit_events where workspace_id = $1 and target_id = $2 and action = 'workflow.published')::text as audits,
        (select count(*) from app.outbox_events where workspace_id = $1 and aggregate_id = $2 and job_name = 'reconcile-workflow-triggers')::text as outbox,
        (select count(*) from app.workflow_versions where workspace_id = $1 and workflow_id = $2)::text as versions`,
        [workspaceId, workflowId],
      );
      expect(facts.rows[0]).toEqual({
        audits: '3',
        outbox: '3',
        versions: '1',
      });
      await api.query('rollback');
    } finally {
      api.release();
    }
  });
});
