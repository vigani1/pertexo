import { expect, it } from 'vitest';
import {
  IdempotencyConflictError,
  actorId,
  apiPool,
  authoring,
  saveCurrentDraft,
  finishTransactionClient,
  workflowDraftRepresentationTag,
  workflowId,
  workspaceId,
} from '../../../support/workflow-authoring.js';

export function registerPublishesAtomicallyReplaysExactlyRejects(): void {
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
    const saved = await saveCurrentDraft(authoring, {
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
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    await expect(
      apiPool.query(
        'update app.workflow_versions set version_number = 99 where id = $1',
        [published.version.id],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const api = await apiPool.connect();
    let apiOpen = false;
    let apiError: unknown;
    try {
      await api.query('begin');
      apiOpen = true;
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
      apiOpen = false;
    } catch (error: unknown) {
      apiError = error;
    }
    await finishTransactionClient(api, {
      label: 'Publication durable-facts proof',
      primaryError: apiError,
      transactionOpen: apiOpen,
    });
  });
}
