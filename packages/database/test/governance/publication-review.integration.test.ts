import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createGovernanceStore } from '../../src/governance/index.js';
import { parseDatabaseConfig } from '../../src/config.js';
import {
  observer,
  inbox,
  preferences,
  mail,
} from '../inbox/notices.fixture.js';
import {
  apiUrl,
  actorId,
  workspaceId,
  authoring,
  identity,
  emptyGraph,
  currentRepresentationTag,
  saveCurrentDraft,
  queryAsOwner,
  otherWorkspaceId,
  enforceTestRetention,
  purgeTestWorkspace,
} from '../support/workflow-authoring.js';
import { createWorkflowAuthoringFixtureDatabase } from '../support/workflow-authoring-admission.fixture.js';

const builder = randomUUID(),
  admin = randomUUID();
let settings: ReturnType<typeof createGovernanceStore>;
beforeAll(async () => {
  settings = createGovernanceStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  );
  for (const [userId, role] of [
    [builder, 'builder'],
    [admin, 'admin'],
  ] as const) {
    await identity.createUser({
      id: userId,
      email: `${userId}@example.test`,
      displayName: role,
    });
    await queryAsOwner(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')",
      [workspaceId, userId, role],
      workspaceId,
    );
  }
  const initial = await settings.settings({ workspaceId, actorId });
  await settings.configure({
    workspaceId,
    actorId,
    expectedRevision: initial.revision,
    requirePublishApproval: true,
    idempotencyKey: randomUUID(),
  });
});
afterAll(async () => settings.close());
function reviews() {
  if (authoring.publicationReviews === undefined)
    throw new Error('Review persistence is missing');
  return authoring.publicationReviews;
}
async function request(requester = builder) {
  const created = await authoring.createWorkflow({
    workspaceId,
    actorId: requester,
    name: 'Reviewed workflow',
    emptyGraph,
    idempotencyKey: randomUUID(),
  });
  const command = {
    workspaceId,
    actorId: requester,
    workflowId: created.workflowId,
    representationTag: await currentRepresentationTag(
      authoring,
      workspaceId,
      created.workflowId,
      requester,
    ),
    note: 'PRIVATE_REVIEW_NOTE',
    idempotencyKey: randomUUID(),
  };
  return { command, review: await reviews().request(command) };
}
it('blocks ordinary publication, then publishes the reviewed revision once with a different reviewer', async () => {
  const { command, review } = await request();
  await expect(
    authoring.publishWorkflow({
      ...command,
      requestHash: 'a'.repeat(64),
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ reason: 'required' });
  expect(
    (await reviews().read({ workspaceId, actorId, reviewId: review.id })).graph,
  ).toEqual(emptyGraph);
  await expect(
    reviews().decide({
      workspaceId,
      actorId: builder,
      reviewId: review.id,
      decision: 'approve',
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toThrow('visible');
  const decision = {
    workspaceId,
    actorId,
    reviewId: review.id,
    decision: 'approve' as const,
    requestId: 'review-decision',
    traceId: 'a'.repeat(32),
    idempotencyKey: randomUUID(),
  };
  const approved = await reviews().decide(decision);
  expect(approved).toMatchObject({
    status: 'approved',
    versionNumber: 1,
    decidedBy: actorId,
    canDecide: false,
  });
  expect(await reviews().decide(decision)).toEqual(approved);
  const facts = await queryAsOwner<{
    action: string;
    metadata: unknown;
    request_id: string | null;
    trace_id: string | null;
  }>(
    'select action,metadata,request_id,trace_id from app.audit_events where workspace_id=$1 and target_id=$2',
    [workspaceId, review.workflowId],
    workspaceId,
  );
  expect(
    facts.filter((fact) => fact.action === 'workflow.published'),
  ).toHaveLength(1);
  expect(
    facts.filter((fact) => fact.action === 'workflow.publication_approved'),
  ).toHaveLength(1);
  expect(
    facts.find((fact) => fact.action === 'workflow.publication_approved'),
  ).toMatchObject({ request_id: 'review-decision', trace_id: 'a'.repeat(32) });
  expect(JSON.stringify(facts)).not.toContain('PRIVATE_REVIEW_NOTE');
});
it('requires another reviewer for an owner request and allows rejection without publishing', async () => {
  const { review } = await request(actorId);
  await expect(
    reviews().decide({
      workspaceId,
      actorId,
      reviewId: review.id,
      decision: 'approve',
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ reason: 'self' });
  const rejected = await reviews().decide({
    workspaceId,
    actorId: admin,
    reviewId: review.id,
    decision: 'reject',
    comment: 'Please clarify the conditions.',
    idempotencyKey: randomUUID(),
  });
  expect(rejected).toMatchObject({
    status: 'rejected',
    publishedVersionId: null,
    comment: 'Please clarify the conditions.',
  });
});
it('invalidates an edited draft without presenting its replacement as the reviewed graph', async () => {
  const { command, review } = await request();
  await saveCurrentDraft(authoring, {
    workspaceId,
    actorId: builder,
    workflowId: review.workflowId,
    expectedRevision: 1,
    graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 60000 } },
  });
  expect(
    await reviews().read({ workspaceId, actorId, reviewId: review.id }),
  ).toMatchObject({
    graph: null,
    request: { status: 'stale', canDecide: false },
  });
  await expect(
    reviews().decide({
      workspaceId,
      actorId,
      reviewId: review.id,
      decision: 'approve',
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ reason: 'stale' });
  expect(
    (
      await reviews().request({
        ...command,
        representationTag: await currentRepresentationTag(
          authoring,
          workspaceId,
          review.workflowId,
          builder,
        ),
        idempotencyKey: randomUUID(),
      })
    ).draftRevision,
  ).toBe(2);
});
it('chooses one winner when reviewers race', async () => {
  const { review } = await request();
  const attempts = await Promise.allSettled(
    [actorId, admin].map((reviewer) =>
      reviews().decide({
        workspaceId,
        actorId: reviewer,
        reviewId: review.id,
        decision: 'approve',
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  expect(
    attempts.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(
    attempts.filter((result) => result.status === 'rejected'),
  ).toHaveLength(1);
});
it('makes policy changes invalidate earlier requests permanently', async () => {
  const { review } = await request();
  for (const enabled of [false, true]) {
    const snapshot = await settings.settings({ workspaceId, actorId });
    await settings.configure({
      workspaceId,
      actorId,
      expectedRevision: snapshot.revision,
      requirePublishApproval: enabled,
      idempotencyKey: randomUUID(),
    });
  }
  expect(
    (await reviews().read({ workspaceId, actorId, reviewId: review.id }))
      .request.status,
  ).toBe('stale');
});
it('rechecks requester membership and seven-day expiry at decision time', async () => {
  const { review } = await request();
  await queryAsOwner(
    "update app.workspace_memberships set role='viewer' where workspace_id=$1 and user_id=$2",
    [workspaceId, builder],
    workspaceId,
  );
  try {
    await expect(
      reviews().decide({
        workspaceId,
        actorId,
        reviewId: review.id,
        decision: 'approve',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'stale' });
  } finally {
    await queryAsOwner(
      "update app.workspace_memberships set role='builder' where workspace_id=$1 and user_id=$2",
      [workspaceId, builder],
      workspaceId,
    );
  }
  await queryAsOwner(
    "update app.workflow_publication_requests set created_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 day' where workspace_id=$1 and id=$2",
    [workspaceId, review.id],
    workspaceId,
  );
  expect(
    (await reviews().read({ workspaceId, actorId, reviewId: review.id }))
      .request.status,
  ).toBe('expired');
});

it('uses the shared inbox audience and personal delivery without exposing the request note', async () => {
  const { review } = await request();
  await queryAsOwner(
    'update app.users set email_verified=true where id=any($1::uuid[])',
    [[actorId, builder, admin]],
  );
  const prefs = preferences();
  await prefs.replace({
    workspaceId,
    actorId: admin,
    expectedRevision: 0,
    mode: 'immediate',
    hour: 9,
    timeZone: 'UTC',
    idempotencyKey: randomUUID(),
  });
  const observe = observer();
  if (observe.observeCurrent === undefined)
    throw new Error('Attention observer missing');
  await observe.observeCurrent();
  const reader = inbox();
  const list = (memberId: string) =>
    reader.listThreads({
      workspaceId,
      actorId: memberId,
      filter: 'all',
      noticeKind: 'publication_review_waiting',
      limit: 100,
    });
  expect(
    (await list(admin)).items.some(
      (item) =>
        item.noticeKind === 'publication_review_waiting' &&
        item.subjectId === review.id,
    ),
  ).toBe(true);
  expect((await list(builder)).items).toHaveLength(0);
  const captured: Parameters<typeof mail>[0] = [];
  await mail(captured).prepare();
  expect(
    captured.some((batch) =>
      batch.items.some((item) => item.subjectId === review.id),
    ),
  ).toBe(true);
  expect(JSON.stringify(captured)).not.toContain('PRIVATE_REVIEW_NOTE');
  await reviews().decide({
    workspaceId,
    actorId,
    reviewId: review.id,
    decision: 'reject',
    idempotencyKey: randomUUID(),
  });
  // The decision hides a notice immediately, before another observer pass.
  expect(
    (await list(admin)).items.some(
      (item) =>
        item.noticeKind === 'publication_review_waiting' &&
        item.subjectId === review.id,
    ),
  ).toBe(false);
});

it('rejects catalog drift and rolls a failed publication back without deciding its request', async () => {
  const { review } = await request();
  const drifted = createWorkflowAuthoringFixtureDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    {
      definitionCatalog: { definitions: [{ key: 'test.drifted', version: 1 }] },
    },
  );
  const broken = createWorkflowAuthoringFixtureDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    {
      executableCompiler: () => {
        throw new Error('Compiler unavailable');
      },
    },
  );
  try {
    if (
      drifted.publicationReviews === undefined ||
      broken.publicationReviews === undefined
    )
      throw new Error('Review persistence missing');
    expect(
      await drifted.publicationReviews.read({
        workspaceId,
        actorId,
        reviewId: review.id,
      }),
    ).toMatchObject({
      graph: null,
      request: { status: 'stale', canDecide: false },
    });
    await expect(
      drifted.publicationReviews.decide({
        workspaceId,
        actorId,
        reviewId: review.id,
        decision: 'approve',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ name: 'WorkflowRevisionConflictError' });
    await expect(
      broken.publicationReviews.decide({
        workspaceId,
        actorId,
        reviewId: review.id,
        decision: 'approve',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('Compiler unavailable');
    expect(
      (await reviews().read({ workspaceId, actorId, reviewId: review.id }))
        .request.status,
    ).toBe('pending');
    const facts = await queryAsOwner<{ count: number }>(
      "select count(*)::int count from app.audit_events where workspace_id=$1 and target_id=$2 and action in ('workflow.published','workflow.publication_approved')",
      [workspaceId, review.workflowId],
      workspaceId,
    );
    expect(facts[0]?.count).toBe(0);
  } finally {
    await Promise.all([drifted.close(), broken.close()]);
  }
});

it('fences reviewer demotion and cross-workspace reads', async () => {
  const { review } = await request();
  await expect(
    reviews().read({
      workspaceId: otherWorkspaceId,
      actorId,
      reviewId: review.id,
    }),
  ).rejects.toThrow('visible');
  await queryAsOwner(
    "update app.workspace_memberships set role='viewer' where workspace_id=$1 and user_id=$2",
    [workspaceId, admin],
    workspaceId,
  );
  try {
    await expect(
      reviews().decide({
        workspaceId,
        actorId: admin,
        reviewId: review.id,
        decision: 'approve',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('visible');
  } finally {
    await queryAsOwner(
      "update app.workspace_memberships set role='admin' where workspace_id=$1 and user_id=$2",
      [workspaceId, admin],
      workspaceId,
    );
  }
});

it('expires request content through the existing maintenance retention owner', async () => {
  const { review } = await request();
  await queryAsOwner(
    "update app.workflow_publication_requests set created_at=clock_timestamp()-interval '39 days',expires_at=clock_timestamp()-interval '32 days' where workspace_id=$1 and id=$2",
    [workspaceId, review.id],
    workspaceId,
  );
  await enforceTestRetention();
  await expect(
    reviews().read({ workspaceId, actorId, reviewId: review.id }),
  ).rejects.toThrow('visible');
});

it('bounds a workspace to 100 pending reviews and frees room after a decision', async () => {
  const workspace = await identity.createWorkspaceWithOwner({
    name: 'Review quota',
    slug: `review-quota-${randomUUID().slice(0, 8)}`,
    ownerUserId: actorId,
  });
  const scope = { workspaceId: workspace.id, actorId };
  const policy = await settings.settings(scope);
  await queryAsOwner(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'admin','active')",
    [workspace.id, admin],
    workspace.id,
  );
  await settings.configure({
    ...scope,
    expectedRevision: policy.revision,
    requirePublishApproval: true,
    idempotencyKey: randomUUID(),
  });
  let first: string | undefined;
  for (let index = 0; index <= 100; index++) {
    const created = await authoring.createWorkflow({
      ...scope,
      name: `Quota ${String(index)}`,
      emptyGraph,
      idempotencyKey: randomUUID(),
    });
    const command = {
      ...scope,
      workflowId: created.workflowId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspace.id,
        created.workflowId,
        actorId,
      ),
      note: 'Review this change.',
      idempotencyKey: randomUUID(),
    };
    if (index < 100) {
      const pending = await reviews().request(command);
      first ??= pending.id;
    } else {
      await expect(reviews().request(command)).rejects.toMatchObject({
        reason: 'limit',
      });
      if (first === undefined) throw new Error('Expected a pending review');
      await reviews().decide({
        workspaceId: workspace.id,
        actorId: admin,
        reviewId: first,
        decision: 'reject',
        idempotencyKey: randomUUID(),
      });
      expect((await reviews().request(command)).status).toBe('pending');
    }
  }
  const purged = await purgeTestWorkspace(workspace.id);
  expect(purged).toContain('workflow_publication_requests');
}, 20000);
