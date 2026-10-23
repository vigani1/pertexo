import type { WorkflowGraph } from '@pertexo/workflow-model';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWorkflowAuthoringFixtureDatabase } from '../../support/workflow-authoring-admission.fixture.js';
import {
  actorId,
  otherActorId,
  workspaceId,
  otherWorkspaceId,
  apiUrl,
  parseDatabaseConfig,
  emptyGraph,
  currentRepresentationTag,
  queryAsOwner,
  purgeTestWorkspace,
  saveCurrentDraft,
} from '../../support/workflow-authoring.js';

const database = createWorkflowAuthoringFixtureDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  {
    definitionCatalog: {
      definitions: [{ key: 'test.placeholder', version: 1 }],
    },
    portableCatalog: {
      definitions: [
        {
          key: 'test.placeholder',
          version: 1,
          configVersion: 1,
          slots: [],
          validateConfig: () => true,
        },
      ],
    },
  },
);
const scope = () => ({ workspaceId, actorId });
function promotions() {
  if (database.promotions === undefined)
    throw new Error('Promotion store missing');
  return database.promotions;
}
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
async function configure() {
  const settings = await promotions().settings(scope());
  return promotions().setTarget({
    ...scope(),
    expectedRevision: settings.revision,
    expectedTargetWorkspaceId: settings.target?.workspaceId ?? null,
    targetWorkspaceId: otherWorkspaceId,
    idempotencyKey: randomUUID(),
  });
}
async function published(graph: WorkflowGraph = emptyGraph) {
  const created = await database.createWorkflow({
    ...scope(),
    name: `Promoted ${randomUUID()}`,
    emptyGraph,
    idempotencyKey: randomUUID(),
  });
  if (graph.nodes.length > 0 || (graph.notes?.length ?? 0) > 0)
    await saveCurrentDraft(database, {
      ...scope(),
      workflowId: created.workflowId,
      expectedRevision: 1,
      graphJson: graph,
    });
  const version = (
    await database.publishWorkflow({
      ...scope(),
      workflowId: created.workflowId,
      representationTag: await currentRepresentationTag(database, workspaceId, {
        scopedWorkflowId: created.workflowId,
        scopedActorId: actorId,
      }),
      requestHash: 'a'.repeat(64),
      idempotencyKey: randomUUID(),
    })
  ).version;
  return { workflowId: created.workflowId, versionId: version.id };
}
registerConfiguresTargetRevisionChecksPermits();

registerRetainsCanvasDocumentationPromotedDraft();

registerQualifies20WorkflowBatchWithin();

async function beforeAllFixture1() {
  await queryAsOwner(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active') on conflict(workspace_id,user_id) do update set role='builder',status='active'",
    [otherWorkspaceId, actorId],
    otherWorkspaceId,
  );
}

async function afterAllFixture2() {
  return database.close();
}

function registerConfiguresTargetRevisionChecksPermits(): void {
  it('configures a target with revision checks and permits an owner to clear it without target access', async () => {
    const initial = await promotions().settings(scope());
    const result = await promotions().setTarget({
      ...scope(),
      expectedRevision: initial.revision,
      expectedTargetWorkspaceId: initial.target?.workspaceId ?? null,
      targetWorkspaceId: otherWorkspaceId,
      idempotencyKey: randomUUID(),
    });
    await expect(
      promotions().setTarget({
        ...scope(),
        expectedRevision: initial.revision,
        expectedTargetWorkspaceId: initial.target?.workspaceId ?? null,
        targetWorkspaceId: null,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'stale' });
    await expect(
      promotions().settings({ ...scope(), actorId: otherActorId }),
    ).rejects.toThrow('visible');
    await queryAsOwner(
      "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
      [otherWorkspaceId, actorId],
      otherWorkspaceId,
    );
    expect(await promotions().settings(scope())).toMatchObject({
      canConfigure: true,
      target: { status: 'unavailable' },
    });
    const cleared = await promotions().setTarget({
      ...scope(),
      expectedRevision: result.revision,
      expectedTargetWorkspaceId: otherWorkspaceId,
      targetWorkspaceId: null,
      idempotencyKey: randomUUID(),
    });
    expect(cleared.revision).toBe(result.revision + 1);
    await queryAsOwner(
      "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
      [otherWorkspaceId, actorId],
      otherWorkspaceId,
    );
  });

  it('applies an exact reviewed version once, records safe history, and protects direct target edits', async () => {
    await configure();
    const selection = await published();
    const preview = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'draft',
    });
    expect(preview.compatible).toBe(true);
    expect(preview.workflows[0]).toMatchObject({
      targetWorkflowId: null,
      directChanges: false,
    });
    const command = {
      ...scope(),
      selections: [selection],
      mode: 'draft' as const,
      fingerprint: preview.fingerprint,
      acknowledgeTargetChanges: [],
      idempotencyKey: randomUUID(),
    };
    const applied = await promotions().apply(command);
    expect(await promotions().apply(command)).toEqual({
      ...applied,
      replayed: true,
    });
    const item = applied.items[0];
    if (item === undefined) throw new Error('Missing promoted workflow');
    expect(
      (
        await database.getDraft(
          otherWorkspaceId,
          item.targetWorkflowId,
          actorId,
        )
      )?.graphJson,
    ).toEqual(emptyGraph);
    expect(
      (await promotions().history({ ...scope(), limit: 20 })).items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          promotionId: applied.promotionId,
          targetWorkflowId: item.targetWorkflowId,
        }),
      ]),
    );
    const cleanReview = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'draft',
    });
    await saveCurrentDraft(database, {
      workspaceId: otherWorkspaceId,
      actorId,
      workflowId: item.targetWorkflowId,
      expectedRevision: 1,
      graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 60000 } },
    });
    await expect(
      promotions().apply({
        ...command,
        idempotencyKey: randomUUID(),
        fingerprint: cleanReview.fingerprint,
      }),
    ).rejects.toMatchObject({ reason: 'stale' });
    const changed = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'draft',
    });
    expect(changed.workflows[0]?.directChanges).toBe(true);
    await expect(
      promotions().apply({
        ...command,
        idempotencyKey: randomUUID(),
        fingerprint: changed.fingerprint,
      }),
    ).rejects.toMatchObject({ reason: 'conflict' });
    await promotions().apply({
      ...command,
      idempotencyKey: randomUUID(),
      fingerprint: changed.fingerprint,
      acknowledgeTargetChanges: [selection.workflowId],
    });
  });

  it('publishes through the normal owner, retains correspondence, and refuses an F18 policy bypass', async () => {
    await configure();
    const selection = await published();
    const preview = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'publish',
    });
    expect(preview.compatible).toBe(true);
    const applied = await promotions().apply({
      ...scope(),
      selections: [selection],
      mode: 'publish',
      fingerprint: preview.fingerprint,
      acknowledgeTargetChanges: [],
      idempotencyKey: randomUUID(),
    });
    const item = applied.items[0];
    if (item === undefined) throw new Error('Missing promoted workflow');
    expect(item.publishedVersionId).not.toBeNull();
    const facts = await queryAsOwner(
      'select source_workflow_id,source_version_id,version_id from app.workflow_version_promotions where workspace_id=$1 and workflow_id=$2',
      [otherWorkspaceId, item.targetWorkflowId],
      otherWorkspaceId,
    );
    expect(facts).toEqual([
      {
        source_workflow_id: selection.workflowId,
        source_version_id: selection.versionId,
        version_id: item.publishedVersionId,
      },
    ]);
    const newReview = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'publish',
    });
    await queryAsOwner(
      'update app.workspaces set require_publish_approval=true where id=$1',
      [otherWorkspaceId],
      otherWorkspaceId,
    );
    try {
      await expect(
        promotions().apply({
          ...scope(),
          selections: [selection],
          mode: 'publish',
          fingerprint: newReview.fingerprint,
          acknowledgeTargetChanges: [],
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ reason: 'stale' });
      expect(
        (
          await promotions().preview({
            ...scope(),
            selections: [selection],
            mode: 'publish',
          })
        ).compatible,
      ).toBe(false);
      const review = await promotions().preview({
        ...scope(),
        selections: [selection],
        mode: 'request_approval',
      });
      const request = await promotions().apply({
        ...scope(),
        selections: [selection],
        mode: 'request_approval',
        fingerprint: review.fingerprint,
        acknowledgeTargetChanges: [],
        note: 'Review the promoted draft.',
        idempotencyKey: randomUUID(),
      });
      expect(request.items[0]?.publicationRequestId).not.toBeNull();
    } finally {
      await queryAsOwner(
        'update app.workspaces set require_publish_approval=false where id=$1',
        [otherWorkspaceId],
        otherWorkspaceId,
      );
    }
  });
}

function registerRetainsCanvasDocumentationPromotedDraft(): void {
  it('retains canvas documentation in the promoted draft and immutable publication', async () => {
    await configure();
    const notes = [
      {
        id: randomUUID(),
        text: '# Production instructions',
        position: { x: 80, y: 160 },
        size: { width: 320, height: 200 },
        color: 'teal' as const,
      },
    ];
    const selection = await published({ ...emptyGraph, notes });
    const preview = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'publish',
    });
    const applied = await promotions().apply({
      ...scope(),
      selections: [selection],
      mode: 'publish',
      fingerprint: preview.fingerprint,
      acknowledgeTargetChanges: [],
      idempotencyKey: randomUUID(),
    });
    const item = applied.items[0];
    if (item?.publishedVersionId == null)
      throw new Error('Missing promoted publication');
    expect(
      (
        await database.getDraft(
          otherWorkspaceId,
          item.targetWorkflowId,
          actorId,
        )
      )?.graphJson.notes,
    ).toEqual(notes);
    expect(
      (
        await database.getVersion(
          otherWorkspaceId,
          item.targetWorkflowId,
          item.publishedVersionId,
          actorId,
        )
      )?.graphJson.notes,
    ).toEqual(notes);
  });

  it('serializes competing applies and rolls the entire reviewed batch back on a conflict', async () => {
    await configure();
    const first = await published(),
      second = await published();
    const review = await promotions().preview({
      ...scope(),
      selections: [first, second],
      mode: 'draft',
    });
    const command = {
      ...scope(),
      selections: [first, second],
      mode: 'draft' as const,
      fingerprint: review.fingerprint,
      acknowledgeTargetChanges: [],
    };
    const competing = await Promise.allSettled([
      promotions().apply({ ...command, idempotencyKey: randomUUID() }),
      promotions().apply({ ...command, idempotencyKey: randomUUID() }),
    ]);
    expect(
      competing.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      competing.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const origins = await queryAsOwner<{
      workflow_id: string;
      draft_revision: number;
    }>(
      'select workflow_id,draft_revision from app.workflow_promotion_origins where workspace_id=$1 and source_workflow_id=any($2::uuid[])',
      [otherWorkspaceId, [first.workflowId, second.workflowId]],
      otherWorkspaceId,
    );
    expect(origins).toHaveLength(2);
    expect(origins.map((row) => row.draft_revision)).toEqual([1, 1]);
    const next = await promotions().preview({
      ...scope(),
      selections: [first, second],
      mode: 'draft',
    });
    const one = origins[0];
    if (one === undefined) throw new Error('Missing origin');
    await saveCurrentDraft(database, {
      workspaceId: otherWorkspaceId,
      actorId,
      workflowId: one.workflow_id,
      expectedRevision: 1,
      graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 30000 } },
    });
    await expect(
      promotions().apply({
        ...command,
        idempotencyKey: randomUUID(),
        fingerprint: next.fingerprint,
      }),
    ).rejects.toMatchObject({ reason: 'stale' });
    const after = await queryAsOwner<{ draft_revision: number }>(
      'select draft_revision from app.workflow_promotion_origins where workspace_id=$1 and source_workflow_id=any($2::uuid[])',
      [otherWorkspaceId, [first.workflowId, second.workflowId]],
      otherWorkspaceId,
    );
    expect(after.map((row) => row.draft_revision)).toEqual([1, 1]);
  });

  it('does not silently adopt an unrelated workflow by name', async () => {
    await configure();
    const selection = await published();
    const source = await database.getWorkflow(
      workspaceId,
      selection.workflowId,
      actorId,
    );
    if (source === null) throw new Error('Missing source');
    await database.createWorkflow({
      workspaceId: otherWorkspaceId,
      actorId,
      name: source.name,
      emptyGraph,
      idempotencyKey: randomUUID(),
    });
    const review = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'draft',
    });
    expect(review.compatible).toBe(false);
    expect(review.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'name', status: 'incompatible' }),
      ]),
    );
  });

  it('rechecks target membership on exact replay and keeps copies independent of source deletion', async () => {
    await configure();
    const selection = await published();
    const review = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'draft',
    });
    const command = {
      ...scope(),
      selections: [selection],
      mode: 'draft' as const,
      fingerprint: review.fingerprint,
      acknowledgeTargetChanges: [],
      idempotencyKey: randomUUID(),
    };
    const result = await promotions().apply(command);
    await queryAsOwner(
      "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
      [otherWorkspaceId, actorId],
      otherWorkspaceId,
    );
    try {
      await expect(promotions().apply(command)).rejects.toThrow('visible');
    } finally {
      await queryAsOwner(
        "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
        [otherWorkspaceId, actorId],
        otherWorkspaceId,
      );
    }
    await queryAsOwner(
      'update app.workflows set published_version_id=null where workspace_id=$1 and id=$2',
      [workspaceId, selection.workflowId],
      workspaceId,
    );
    await queryAsOwner(
      'delete from app.workflow_versions where workspace_id=$1 and workflow_id=$2',
      [workspaceId, selection.workflowId],
      workspaceId,
    );
    const item = result.items[0];
    if (item === undefined) throw new Error('Missing promoted workflow');
    expect(
      await database.getDraft(otherWorkspaceId, item.targetWorkflowId, actorId),
    ).not.toBeNull();
    expect(await promotions().apply(command)).toEqual({
      ...result,
      replayed: true,
    });
  });
}

function registerQualifies20WorkflowBatchWithin(): void {
  it('qualifies a 20-workflow batch within byte bounds and refuses a review that exceeds them', async () => {
    await configure();
    const selections = [];
    const largeGraph = (bytes: number): WorkflowGraph => ({
      ...emptyGraph,
      nodes: [
        {
          id: 'payload',
          definition: { key: 'test.placeholder', version: 1 },
          configVersion: 1,
          config: { value: 'x'.repeat(bytes) },
          inputMappings: {},
          connectionRefs: {},
          position: { x: 0, y: 0 },
        },
      ],
    });
    for (let index = 0; index < 20; index++)
      selections.push(await published(largeGraph(50_000)));
    const started = performance.now(),
      memoryBefore = process.memoryUsage();
    const review = await promotions().preview({
      ...scope(),
      selections,
      mode: 'draft',
    });
    const previewMs = performance.now() - started;
    expect(review.compatible).toBe(true);
    const applying = performance.now();
    await promotions().apply({
      ...scope(),
      selections,
      mode: 'draft',
      fingerprint: review.fingerprint,
      acknowledgeTargetChanges: [],
      idempotencyKey: randomUUID(),
    });
    const applyMs = performance.now() - applying;
    const maximumReview = await promotions().preview({
      ...scope(),
      selections,
      mode: 'draft',
    });
    const memoryAfter = process.memoryUsage();
    const responseBytes = Buffer.byteLength(JSON.stringify(maximumReview));
    expect(responseBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(maximumReview.workflows).toHaveLength(20);
    process.stdout.write(
      `PROMOTION_BOUND=${JSON.stringify({
        workflows: 20,
        responseBytes,
        previewMs,
        applyMs,
        rssBefore: memoryBefore.rss,
        rssAfter: memoryAfter.rss,
        maxRssKiB: process.resourceUsage().maxRSS,
        rssDelta: memoryAfter.rss - memoryBefore.rss,
        heapDelta: memoryAfter.heapUsed - memoryBefore.heapUsed,
      })}\n`,
    );
    const huge = await published(largeGraph(980_000));
    await expect(
      promotions().preview({
        ...scope(),
        selections: [huge, ...selections.slice(0, 19)],
        mode: 'draft',
      }),
    ).rejects.toMatchObject({ reason: 'limit' });
  }, 60000);

  it('records correspondence after F18 approves exactly the promoted draft, but never for a later manual edit', async () => {
    await configure();
    const selection = await published();
    await queryAsOwner(
      'update app.workspaces set require_publish_approval=true where id=$1',
      [otherWorkspaceId],
      otherWorkspaceId,
    );
    const reviews = database.publicationReviews;
    if (reviews === undefined) throw new Error('Review owner missing');
    let targetWorkflowId = '';
    try {
      const review = await promotions().preview({
        ...scope(),
        selections: [selection],
        mode: 'request_approval',
      });
      const applied = await promotions().apply({
        ...scope(),
        selections: [selection],
        mode: 'request_approval',
        fingerprint: review.fingerprint,
        acknowledgeTargetChanges: [],
        note: 'Review the exact promoted version.',
        idempotencyKey: randomUUID(),
      });
      const item = applied.items[0];
      if (item?.publicationRequestId === null || item === undefined)
        throw new Error('Publication review missing');
      targetWorkflowId = item.targetWorkflowId;
      const approved = await reviews.decide({
        workspaceId: otherWorkspaceId,
        actorId: otherActorId,
        reviewId: item.publicationRequestId,
        decision: 'approve',
        idempotencyKey: randomUUID(),
      });
      expect(approved.status).toBe('approved');
      expect(
        await queryAsOwner(
          'select version_id from app.workflow_version_promotions where workspace_id=$1 and workflow_id=$2',
          [otherWorkspaceId, targetWorkflowId],
          otherWorkspaceId,
        ),
      ).toEqual([{ version_id: approved.publishedVersionId }]);
    } finally {
      await queryAsOwner(
        'update app.workspaces set require_publish_approval=false where id=$1',
        [otherWorkspaceId],
        otherWorkspaceId,
      );
    }
    await saveCurrentDraft(database, {
      workspaceId: otherWorkspaceId,
      actorId,
      workflowId: targetWorkflowId,
      expectedRevision: 1,
      graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 15000 } },
    });
    const manual = await database.publishWorkflow({
      workspaceId: otherWorkspaceId,
      actorId,
      workflowId: targetWorkflowId,
      representationTag: await currentRepresentationTag(
        database,
        otherWorkspaceId,
        { scopedWorkflowId: targetWorkflowId, scopedActorId: actorId },
      ),
      requestHash: 'a'.repeat(64),
      idempotencyKey: randomUUID(),
    });
    expect(
      await queryAsOwner(
        'select version_id from app.workflow_version_promotions where workspace_id=$1 and version_id=$2',
        [otherWorkspaceId, manual.version.id],
        otherWorkspaceId,
      ),
    ).toEqual([]);
  });

  it('purges each environment independently and removes its owned promotion metadata', async () => {
    await configure();
    const selection = await published();
    const review = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'publish',
    });
    const applied = await promotions().apply({
      ...scope(),
      selections: [selection],
      mode: 'publish',
      fingerprint: review.fingerprint,
      acknowledgeTargetChanges: [],
      idempotencyKey: randomUUID(),
    });
    const item = applied.items[0];
    if (item === undefined) throw new Error('Promoted target missing');
    await purgeTestWorkspace(workspaceId);
    expect(
      await database.getDraft(otherWorkspaceId, item.targetWorkflowId, actorId),
    ).not.toBeNull();
    expect(
      await queryAsOwner(
        'select source_workspace_id,source_workflow_id from app.workflow_version_promotions where workspace_id=$1 and workflow_id=$2',
        [otherWorkspaceId, item.targetWorkflowId],
        otherWorkspaceId,
      ),
    ).toEqual([
      {
        source_workspace_id: workspaceId,
        source_workflow_id: selection.workflowId,
      },
    ]);
    await purgeTestWorkspace(otherWorkspaceId);
    expect(
      await queryAsOwner(
        'select (select count(*)::int from app.workspace_promotion_targets where workspace_id=any($1::uuid[])) links,(select count(*)::int from app.workflow_promotion_origins where workspace_id=$2) origins,(select count(*)::int from app.workflow_version_promotions where workspace_id=$2) versions',
        [[workspaceId, otherWorkspaceId], otherWorkspaceId],
        otherWorkspaceId,
      ),
    ).toEqual([{ links: 0, origins: 0, versions: 0 }]);
  }, 60000);
}
