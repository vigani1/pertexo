import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeWorkflowLifecycleApiFixture,
  createWorkflowLifecycleApiFixture,
  expectProblem,
  mutationHeaders,
  type WorkflowLifecycleApiFixture,
  type WorkflowHistory,
  workflowLifecycleIntegrationEnabled,
} from '../support/workflow-lifecycle.integration.support.js';

const describeIntegration = workflowLifecycleIntegrationEnabled
  ? describe
  : describe.skip;

type LifecycleResponse = Readonly<{
  workflow: Readonly<{
    id: string;
    workspaceId: string;
    name: string;
    lifecycleStatus: 'active' | 'archived';
    lifecycleRevision: number;
    activationStatus:
      | 'inactive'
      | 'activating'
      | 'active'
      | 'deactivating'
      | 'degraded'
      | 'error';
    publishedVersionId: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  replayed: boolean;
}>;

describeIntegration('authenticated workflow lifecycle HTTP commands', () => {
  let fixture: WorkflowLifecycleApiFixture;

  beforeAll(async () => {
    fixture = await createWorkflowLifecycleApiFixture();
  });

  afterAll(async () => {
    await closeWorkflowLifecycleApiFixture(fixture);
  });

  it('requires authentication, CSRF, one idempotency key, strict input, and publication authority', async () => {
    const { application, ids, workspaceId } = fixture;
    const owner = await fixture.login('owner');
    const body = { expectedLifecycleRevision: 1 };

    for (const command of ['archive', 'restore'] as const) {
      const path = lifecyclePath(workspaceId, ids.unpublished, command);
      const unauthenticated = await application.inject({
        method: 'POST',
        url: path,
        headers: { 'idempotency-key': `unauthenticated-${command}` },
        payload: body,
      });
      expectProblem(unauthenticated, 401, 'auth.unauthenticated');

      const missingCsrf = await application.inject({
        method: 'POST',
        url: path,
        headers: {
          cookie: owner.cookieHeader,
          'idempotency-key': `missing-csrf-${command}`,
        },
        payload: body,
      });
      expectProblem(missingCsrf, 403, 'auth.forbidden');

      const missingKey = await application.inject({
        method: 'POST',
        url: path,
        headers: { cookie: owner.cookieHeader, 'x-csrf-token': owner.csrf },
        payload: body,
      });
      expectProblem(missingKey, 400, 'request.invalid');

      const combinedKey = await application.inject({
        method: 'POST',
        url: path,
        headers: mutationHeaders(owner, {
          'idempotency-key': `first-${command},second-${command}`,
        }),
        payload: body,
      });
      expectProblem(combinedKey, 400, 'request.invalid');

      const duplicateHeaders = await application.inject({
        method: 'POST',
        url: path,
        headers: {
          cookie: owner.cookieHeader,
          'x-csrf-token': owner.csrf,
          'idempotency-key': [
            `duplicate-one-${command}`,
            `duplicate-two-${command}`,
          ],
        },
        payload: body,
      });
      expectProblem(duplicateHeaders, 400, 'request.invalid');

      const extraBody = await application.inject({
        method: 'POST',
        url: path,
        headers: mutationHeaders(owner),
        payload: { ...body, unexpected: true },
      });
      expectProblem(extraBody, 400, 'request.invalid');

      const invalidRevision = await application.inject({
        method: 'POST',
        url: path,
        headers: mutationHeaders(owner),
        payload: { expectedLifecycleRevision: 0 },
      });
      expectProblem(invalidRevision, 400, 'request.invalid');
    }

    for (const role of ['operator', 'viewer'] as const) {
      const cookies = await fixture.login(role);
      for (const command of ['archive', 'restore'] as const) {
        const denied = await application.inject({
          method: 'POST',
          url: lifecyclePath(workspaceId, ids.unpublished, command),
          headers: mutationHeaders(cookies),
          payload: body,
        });
        expectProblem(denied, 404, 'resource.not_found');
      }
    }

    const wrongTenant = await application.inject({
      method: 'POST',
      url: lifecyclePath(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ids.unpublished,
        'archive',
      ),
      headers: mutationHeaders(owner),
      payload: body,
    });
    expectProblem(wrongTenant, 404, 'resource.not_found');

    await fixture.setWorkspaceStatus('suspended');
    try {
      for (const command of ['archive', 'restore'] as const) {
        const denied = await application.inject({
          method: 'POST',
          url: lifecyclePath(workspaceId, ids.unpublished, command),
          headers: mutationHeaders(owner),
          payload: body,
        });
        expectProblem(denied, 404, 'resource.not_found');
      }
    } finally {
      await fixture.setWorkspaceStatus('active');
    }

    await fixture.setWorkspaceStatus('pending_deletion');
    try {
      const pendingOwner = await fixture.login('owner');
      for (const command of ['archive', 'restore'] as const) {
        const denied = await application.inject({
          method: 'POST',
          url: lifecyclePath(workspaceId, ids.unpublished, command),
          headers: mutationHeaders(pendingOwner),
          payload: body,
        });
        expectProblem(denied, 404, 'resource.not_found');
      }
    } finally {
      await fixture.setWorkspaceStatus('active');
    }
  });

  it('archives and restores an unpublished workflow with exact concurrent idempotency and CAS', async () => {
    const { application, ids, workspaceId } = fixture;
    const owner = await fixture.login('owner');
    const path = lifecyclePath(workspaceId, ids.unpublished, 'archive');
    const archiveHeaders = mutationHeaders(owner, {
      'idempotency-key': 'unpublished-archive-concurrent',
    });
    const archiveRequests = await Promise.all([
      application.inject({
        method: 'POST',
        url: path,
        headers: archiveHeaders,
        payload: { expectedLifecycleRevision: 1 },
      }),
      application.inject({
        method: 'POST',
        url: path,
        headers: archiveHeaders,
        payload: { expectedLifecycleRevision: 1 },
      }),
    ]);
    expect(archiveRequests.map(({ statusCode }) => statusCode).sort()).toEqual([
      202, 202,
    ]);
    const archiveBodies = archiveRequests.map((response) =>
      response.json<LifecycleResponse>(),
    );
    const acceptedArchive = archiveBodies.find(({ replayed }) => !replayed);
    if (acceptedArchive === undefined)
      throw new Error('accepted archive response missing');
    expect(archiveBodies.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(archiveBodies[0]?.workflow).toMatchObject({
      id: ids.unpublished,
      lifecycleStatus: 'archived',
      lifecycleRevision: 2,
      activationStatus: 'inactive',
      publishedVersionId: null,
    });
    expect(archiveBodies[0]?.workflow).toEqual(archiveBodies[1]?.workflow);
    expectExactLifecycleResponse(archiveRequests[0], ids.unpublished);

    const replay = await application.inject({
      method: 'POST',
      url: path,
      headers: archiveHeaders,
      payload: { expectedLifecycleRevision: 1 },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json<LifecycleResponse>()).toEqual({
      replayed: true,
      workflow: acceptedArchive.workflow,
    });

    const mismatch = await application.inject({
      method: 'POST',
      url: path,
      headers: archiveHeaders,
      payload: { expectedLifecycleRevision: 2 },
    });
    expectProblem(mismatch, 409, 'request.idempotency_conflict');

    const restored = await application.inject({
      method: 'POST',
      url: lifecyclePath(workspaceId, ids.unpublished, 'restore'),
      headers: mutationHeaders(owner, {
        'idempotency-key': 'unpublished-restore',
      }),
      payload: { expectedLifecycleRevision: 2 },
    });
    expectLifecycleResponse(restored, {
      id: ids.unpublished,
      lifecycleStatus: 'active',
      lifecycleRevision: 3,
      activationStatus: 'inactive',
      publishedVersionId: null,
      replayed: false,
    });

    const replayAfterRestore = await application.inject({
      method: 'POST',
      url: path,
      headers: archiveHeaders,
      payload: { expectedLifecycleRevision: 1 },
    });
    expect(replayAfterRestore.statusCode).toBe(202);
    expect(replayAfterRestore.json<LifecycleResponse>()).toEqual({
      replayed: true,
      workflow: acceptedArchive.workflow,
    });
    expect(await fixture.readLifecycle(ids.unpublished)).toEqual({
      lifecycleStatus: 'active',
      lifecycleRevision: 3,
      activationStatus: 'inactive',
      publishedVersionId: null,
    });

    const beforeNoop = await fixture.readHistory(ids.unpublished);
    const beforeNoopFacts = await lifecycleFacts(fixture, ids.unpublished);
    const noop = await application.inject({
      method: 'POST',
      url: lifecyclePath(workspaceId, ids.unpublished, 'restore'),
      headers: mutationHeaders(owner, {
        'idempotency-key': 'unpublished-noop',
      }),
      payload: { expectedLifecycleRevision: 3 },
    });
    expectLifecycleResponse(noop, {
      id: ids.unpublished,
      lifecycleStatus: 'active',
      lifecycleRevision: 3,
      activationStatus: 'inactive',
      publishedVersionId: null,
      replayed: false,
    });
    await expectHistoryUnchanged(fixture, ids.unpublished, beforeNoop);
    expect(await lifecycleFacts(fixture, ids.unpublished)).toEqual(
      beforeNoopFacts,
    );

    const stale = await application.inject({
      method: 'POST',
      url: path,
      headers: mutationHeaders(owner, {
        'idempotency-key': 'unpublished-stale',
      }),
      payload: { expectedLifecycleRevision: 1 },
    });
    expectProblem(stale, 409, 'workflow.lifecycle_conflict');
    expect(stale.json()).toMatchObject({ currentLifecycleRevision: 3 });
  });

  it('archives and restores a published workflow without changing draft, version, or run history', async () => {
    const { application, ids, workspaceId } = fixture;
    const owner = await fixture.login('owner');
    const before = await fixture.readHistory(ids.published);
    expect(before.runs).toEqual([
      {
        id: ids.run,
        status: 'succeeded',
        workflowVersionId: ids.publishedVersion,
      },
    ]);
    const beforeFacts = await lifecycleFacts(fixture, ids.published);

    const archive = await application.inject({
      method: 'POST',
      url: lifecyclePath(workspaceId, ids.published, 'archive'),
      headers: mutationHeaders(owner, {
        'idempotency-key': 'published-archive',
      }),
      payload: { expectedLifecycleRevision: 1 },
    });
    expectLifecycleResponse(archive, {
      id: ids.published,
      lifecycleStatus: 'archived',
      lifecycleRevision: 2,
      activationStatus: 'deactivating',
      publishedVersionId: ids.publishedVersion,
      replayed: false,
    });
    await expectHistoryUnchanged(fixture, ids.published, before);

    const afterArchiveFacts = await lifecycleFacts(fixture, ids.published);
    expect(afterArchiveFacts).toEqual({
      audit: beforeFacts.audit + 1,
      reconciliationOutbox: beforeFacts.reconciliationOutbox + 1,
    });

    const archiveRetry = await application.inject({
      method: 'POST',
      url: lifecyclePath(workspaceId, ids.published, 'archive'),
      headers: mutationHeaders(owner, {
        'idempotency-key': 'published-archive',
      }),
      payload: { expectedLifecycleRevision: 1 },
    });
    expectLifecycleResponse(archiveRetry, {
      id: ids.published,
      lifecycleStatus: 'archived',
      lifecycleRevision: 2,
      activationStatus: 'deactivating',
      publishedVersionId: ids.publishedVersion,
      replayed: true,
    });
    expect(await lifecycleFacts(fixture, ids.published)).toEqual(
      afterArchiveFacts,
    );

    const restore = await application.inject({
      method: 'POST',
      url: lifecyclePath(workspaceId, ids.published, 'restore'),
      headers: mutationHeaders(owner, {
        'idempotency-key': 'published-restore',
      }),
      payload: { expectedLifecycleRevision: 2 },
    });
    expectLifecycleResponse(restore, {
      id: ids.published,
      lifecycleStatus: 'active',
      lifecycleRevision: 3,
      activationStatus: 'activating',
      publishedVersionId: ids.publishedVersion,
      replayed: false,
    });
    await expectHistoryUnchanged(fixture, ids.published, before);
    expect(await lifecycleFacts(fixture, ids.published)).toEqual({
      audit: beforeFacts.audit + 2,
      reconciliationOutbox: beforeFacts.reconciliationOutbox + 2,
    });

    const raceHeaders = [
      mutationHeaders(owner, { 'idempotency-key': 'published-cas-a' }),
      mutationHeaders(owner, { 'idempotency-key': 'published-cas-b' }),
    ];
    const beforeRace = await fixture.readHistory(ids.published);
    const beforeRaceFacts = await lifecycleFacts(fixture, ids.published);
    const race = await Promise.all(
      raceHeaders.map((headers) =>
        application.inject({
          method: 'POST',
          url: lifecyclePath(workspaceId, ids.published, 'archive'),
          headers,
          payload: { expectedLifecycleRevision: 3 },
        }),
      ),
    );
    expect(race.map(({ statusCode }) => statusCode).sort()).toEqual([202, 409]);
    const conflict = race.find(({ statusCode }) => statusCode === 409);
    if (conflict === undefined)
      throw new Error('CAS conflict response missing');
    expectProblem(conflict, 409, 'workflow.lifecycle_conflict');
    expect(conflict.json()).toMatchObject({ currentLifecycleRevision: 4 });
    await expectHistoryUnchanged(fixture, ids.published, beforeRace);
    expect(await lifecycleFacts(fixture, ids.published)).toEqual({
      audit: beforeRaceFacts.audit + 1,
      reconciliationOutbox: beforeRaceFacts.reconciliationOutbox + 1,
    });
  });
});

function lifecyclePath(
  workspaceId: string,
  workflowId: string,
  command: 'archive' | 'restore',
): string {
  return `/v1/workspaces/${workspaceId}/workflows/${workflowId}/${command}`;
}

function expectLifecycleResponse(
  response: Readonly<{
    statusCode: number;
    payload: string;
    json(): unknown;
  }>,
  expected: Readonly<{
    id: string;
    lifecycleStatus: 'active' | 'archived';
    lifecycleRevision: number;
    activationStatus: LifecycleResponse['workflow']['activationStatus'];
    publishedVersionId: string | null;
    replayed: boolean;
  }>,
): void {
  expect(response.statusCode, response.payload).toBe(202);
  const body = response.json() as LifecycleResponse;
  expect(Object.keys(body).sort()).toEqual(['replayed', 'workflow']);
  expect(Object.keys(body.workflow).sort()).toEqual([
    'activationStatus',
    'createdAt',
    'id',
    'lifecycleRevision',
    'lifecycleStatus',
    'name',
    'publishedVersionId',
    'updatedAt',
    'workspaceId',
  ]);
  expect(body).toMatchObject({
    replayed: expected.replayed,
    workflow: {
      id: expected.id,
      lifecycleStatus: expected.lifecycleStatus,
      lifecycleRevision: expected.lifecycleRevision,
      activationStatus: expected.activationStatus,
      publishedVersionId: expected.publishedVersionId,
    },
  });
}

function expectExactLifecycleResponse(
  response: Readonly<{
    json(): unknown;
  }>,
  workflowId: string,
): void {
  const body = response.json() as LifecycleResponse;
  expect(body.workflow.id).toBe(workflowId);
  expect(body.workflow.createdAt).toEqual(expect.any(String));
  expect(body.workflow.updatedAt).toEqual(expect.any(String));
}

async function expectHistoryUnchanged(
  fixture: WorkflowLifecycleApiFixture,
  workflowId: string,
  before: WorkflowHistory,
): Promise<void> {
  expect(await fixture.readHistory(workflowId)).toEqual(before);
}

async function lifecycleFacts(
  fixture: WorkflowLifecycleApiFixture,
  workflowId: string,
): Promise<Readonly<{ audit: number; reconciliationOutbox: number }>> {
  return fixture.withOwner(async (client) => {
    const result = await client.query<{
      audit: string;
      reconciliation_outbox: string;
    }>(
      `select
         (select count(*)::text from app.audit_events
           where workspace_id=$1 and target_type='workflow' and target_id=$2
             and action in ('workflow.archived','workflow.restored')) as audit,
         (select count(*)::text from app.outbox_events
           where workspace_id=$1 and aggregate_id=$2
             and job_name='reconcile-workflow-triggers') as reconciliation_outbox`,
      [fixture.workspaceId, workflowId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('workflow lifecycle facts missing');
    return {
      audit: Number(row.audit),
      reconciliationOutbox: Number(row.reconciliation_outbox),
    };
  });
}
