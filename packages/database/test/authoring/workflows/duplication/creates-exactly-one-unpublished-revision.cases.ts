import { expect, it } from 'vitest';
import {
  IdempotencyConflictError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  actorId,
  apiUrl,
  authoring,
  createWorkflowAuthoringDatabase,
  currentRepresentationTag,
  emptyGraph,
  otherActorId,
  otherVersionId,
  otherWorkflowId,
  otherWorkspaceId,
  parseDatabaseConfig,
  queryAsOwner,
  randomUUID,
  saveCurrentDraft,
  workspaceId,
} from '../../../support/workflow-authoring.js';
import { source, command, facts, commandFacts } from './fixture.js';

export function registerCreatesExactlyOneUnpublishedRevision(): void {
  it('creates exactly one unpublished revision-1 draft with fresh operational defaults and identifier-only recovery', async () => {
    const original = await source();
    await authoring.publishWorkflow({
      actorId,
      workspaceId,
      workflowId: original.workflowId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        { scopedWorkflowId: original.workflowId, scopedActorId: actorId },
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
        { scopedWorkflowId: original.workflowId, scopedActorId: actorId },
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
}
