import { describe, expect, it } from 'vitest';
import { enabled, invitationKeys } from './real-api/environment.js';
import { createWorkspaceApiFixture } from './real-api/fixture.js';
import {
  workflowSummaryResponseSchema,
  workflowRunListResponseSchema,
  workflowRunStatisticsResponseSchema,
} from '@pertexo/contracts';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  outboxEvents,
  runCheckpoints,
  runEvents,
  workflowRuns,
} from '@pertexo/database/testing';
import {
  SESSION_AUTHORITY,
  type IdentitySessionAuthority,
} from '../../src/workspaces/index.js';
import { createActorContext } from '../../src/authorization/index.js';
import { StreamRunEventsUseCase } from '../../src/workflow-runs/index.js';
import {
  mutationHeaders,
  sessionCookies,
  cookieValue,
} from './real-api/cookies.js';
import { withTimeout, openHttpEventStream } from './real-api/streams.js';
import { expectProblem } from './real-api/assertions.js';
import type { SessionCookies } from './real-api/contract.js';
import { createApplicationSecretEnvelope } from '@pertexo/secrets/server';

describe.runIf(enabled)('Phase 1 real PostgreSQL API identity slice', () => {
  const caseFixture = createWorkspaceApiFixture();
  const { login, createPublishedWorkflow } = caseFixture;

  it('authors and publishes a workflow through real auth, RLS, and ETags', async () => {
    const cookies = await login();
    const { base, createdBody, publishedBody } =
      await createPublishedWorkflow(cookies);

    const read = await caseFixture.application.inject({
      method: 'GET',
      url: `${base}/${createdBody.workflow.id}`,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(read.statusCode).toBe(200);
    expect(
      workflowSummaryResponseSchema.parse(read.json()).workflow
        .publishedVersionId,
    ).toBe(publishedBody.version.id);
  });
  const {
    login: login2,
    createPublishedWorkflow: createPublishedWorkflow2,
    withOwnerWorkspace,
    archiveWorkflow,
  } = caseFixture;

  it('starts, replays, reads, cancels, and streams a durable workflow run', async () => {
    let cookies = await login2();
    const { workspace, base, createdBody, publishedBody } =
      await createPublishedWorkflow2(cookies);

    const runHeaders = mutationHeaders(cookies, {
      'idempotency-key': 'workflow-run-start-proof',
    });
    const started = await caseFixture.application.inject({
      method: 'POST',
      url: `${base}/${createdBody.workflow.id}/runs`,
      headers: runHeaders,
      payload: { input: { customerId: 'customer-42' } },
    });
    expect(started.statusCode).toBe(202);
    const startedBody = started.json<
      Readonly<{
        run: Readonly<{ id: string; status: string }>;
        replayed: boolean;
      }>
    >();
    expect(startedBody).toMatchObject({
      run: { status: 'queued' },
      replayed: false,
    });

    const startReplay = await caseFixture.application.inject({
      method: 'POST',
      url: `${base}/${createdBody.workflow.id}/runs`,
      headers: runHeaders,
      payload: { input: { customerId: 'customer-42' } },
    });
    expect(startReplay.statusCode).toBe(202);
    expect(startReplay.json()).toMatchObject({
      run: { id: startedBody.run.id },
      replayed: true,
    });
    const startConflict = await caseFixture.application.inject({
      method: 'POST',
      url: `${base}/${createdBody.workflow.id}/runs`,
      headers: runHeaders,
      payload: { input: { customerId: 'different' } },
    });
    expectProblem(startConflict, 409, 'request.idempotency_conflict');

    const runUrl = `/v1/workspaces/${workspace.id}/runs/${startedBody.run.id}`;

    const replayHeaders = mutationHeaders(cookies, {
      'idempotency-key': 'workflow-run-replay-proof',
    });
    const replayed = await caseFixture.application.inject({
      method: 'POST',
      url: `${runUrl}/replay`,
      headers: replayHeaders,
      payload: {
        workflowVersionId: publishedBody.version.id,
        input: { customerId: 'replay-customer-42' },
      },
    });
    expect(replayed.statusCode, replayed.payload).toBe(202);
    const replayedBody = replayed.json<
      Readonly<{
        run: Readonly<{
          id: string;
          status: string;
          triggerType: string;
          workflowVersionId: string;
        }>;
        replayed: boolean;
      }>
    >();
    expect(replayedBody).toMatchObject({
      run: {
        status: 'queued',
        triggerType: 'replay',
        workflowVersionId: publishedBody.version.id,
      },
      replayed: false,
    });
    expect(replayedBody.run.id).not.toBe(startedBody.run.id);

    const replayRetry = await caseFixture.application.inject({
      method: 'POST',
      url: `${runUrl}/replay`,
      headers: replayHeaders,
      payload: {
        workflowVersionId: publishedBody.version.id,
        input: { customerId: 'replay-customer-42' },
      },
    });
    expect(replayRetry.statusCode).toBe(202);
    expect(replayRetry.json()).toMatchObject({
      run: { id: replayedBody.run.id },
      replayed: true,
    });
    const replayConflict = await caseFixture.application.inject({
      method: 'POST',
      url: `${runUrl}/replay`,
      headers: replayHeaders,
      payload: {
        workflowVersionId: publishedBody.version.id,
        input: { customerId: 'different-replay-input' },
      },
    });
    expectProblem(replayConflict, 409, 'request.idempotency_conflict');

    for (const denial of [
      {
        statement:
          'update app.workspace_memberships set role=$2 where workspace_id=$1',
        denied: 'builder',
        restored: 'owner',
      },
      {
        statement: 'update app.workspaces set status=$2 where id=$1',
        denied: 'suspended',
        restored: 'active',
      },
    ]) {
      await withOwnerWorkspace(workspace.id, (client) =>
        client.query(denial.statement, [workspace.id, denial.denied]),
      );
      try {
        // Suspension revokes members' sessions (ADR 013); a fresh sign-in
        // still finds the workspace hidden.
        const denied = await login2();
        const forbiddenReplay = await caseFixture.application.inject({
          method: 'POST',
          url: `${runUrl}/replay`,
          headers: mutationHeaders(denied, {
            'idempotency-key': `replay-denied-${denial.denied}`,
          }),
          payload: {
            workflowVersionId: publishedBody.version.id,
            input: { customerId: 'denied' },
          },
        });
        expectProblem(forbiddenReplay, 404, 'resource.not_found');
      } finally {
        await withOwnerWorkspace(workspace.id, (client) =>
          client.query(denial.statement, [workspace.id, denial.restored]),
        );
      }
    }
    cookies = await login2();

    const missingReplayCsrf = await caseFixture.application.inject({
      method: 'POST',
      url: `${runUrl}/replay`,
      headers: {
        cookie: cookies.cookieHeader,
        'idempotency-key': 'workflow-run-replay-missing-csrf',
      },
      payload: {
        workflowVersionId: publishedBody.version.id,
        input: { customerId: 'csrf-probe' },
      },
    });
    expectProblem(missingReplayCsrf, 403, 'auth.forbidden');

    const hiddenReplay = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${randomUUID()}/runs/${startedBody.run.id}/replay`,
      headers: mutationHeaders(cookies, {
        'idempotency-key': 'workflow-run-replay-hidden',
      }),
      payload: {
        workflowVersionId: publishedBody.version.id,
        input: { customerId: 'hidden-probe' },
      },
    });
    expectProblem(hiddenReplay, 404, 'resource.not_found');

    await archiveWorkflow(workspace.id, createdBody.workflow.id);
    const archivedReplay = await caseFixture.application.inject({
      method: 'POST',
      url: `${runUrl}/replay`,
      headers: mutationHeaders(cookies, {
        'idempotency-key': 'workflow-run-replay-archived',
      }),
      payload: {
        workflowVersionId: publishedBody.version.id,
        input: { customerId: 'archived-probe' },
      },
    });
    expectProblem(archivedReplay, 409, 'workflow.not_published');

    const readRun = await caseFixture.application.inject({
      method: 'GET',
      url: runUrl,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(readRun.statusCode).toBe(200);
    expect(readRun.json()).toMatchObject({
      run: {
        id: startedBody.run.id,
        workflowVersionId: publishedBody.version.id,
        workflowName: 'Inbound automation',
      },
      nodes: [],
    });
    const workflowMetadata = await caseFixture.application.inject({
      method: 'GET',
      url: `${base}/${createdBody.workflow.id}`,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(workflowMetadata.statusCode).toBe(200);
    expect(workflowMetadata.json()).toMatchObject({
      workflow: {
        id: createdBody.workflow.id,
        name: 'Inbound automation',
        lifecycleStatus: 'archived',
      },
    });
    const namedRuns = await caseFixture.application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspace.id}/runs?workflowNamePrefix=inbound`,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(namedRuns.statusCode).toBe(200);
    const namedRunsBody = workflowRunListResponseSchema.parse(namedRuns.json());
    expect(
      namedRunsBody.items.some(
        ({ id, workflowName }) =>
          id === startedBody.run.id && workflowName === 'Inbound automation',
      ),
    ).toBe(true);
    const statistics = await caseFixture.application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspace.id}/run-statistics?window=1h&breakdown=workflow`,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(statistics.statusCode).toBe(200);
    expect(
      workflowRunStatisticsResponseSchema.parse(statistics.json()),
    ).toMatchObject({
      current: { queued: 2, running: 0, waiting: 0 },
      window: { duration: '1h', total: 2, byStatus: { queued: 2 } },
      workflows: {
        truncated: false,
        items: [
          {
            workflowId: createdBody.workflow.id,
            workflowName: 'Inbound automation',
            total: 2,
          },
        ],
      },
    });
    const hiddenStatistics = await caseFixture.application.inject({
      method: 'GET',
      url: `/v1/workspaces/${randomUUID()}/run-statistics`,
      headers: { cookie: cookies.cookieHeader },
    });
    expectProblem(hiddenStatistics, 404, 'resource.not_found');

    const canceled = await caseFixture.application.inject({
      method: 'POST',
      url: `${runUrl}/cancel`,
      headers: mutationHeaders(cookies),
      payload: { reason: 'operator request' },
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json()).toMatchObject({ alreadyRequested: false });
    const cancelReplay = await caseFixture.application.inject({
      method: 'POST',
      url: `${runUrl}/cancel`,
      headers: mutationHeaders(cookies),
      payload: { reason: 'operator request' },
    });
    expect(cancelReplay.statusCode).toBe(200);
    expect(cancelReplay.json()).toMatchObject({ alreadyRequested: true });

    const durableRunEffects = await caseFixture.workspaceDatabase.withWorkspace(
      workspace.id,
      async (transaction) => {
        const runs = await transaction.db.select().from(workflowRuns);
        const checkpoints = await transaction.db.select().from(runCheckpoints);
        const events = await transaction.db.select().from(runEvents);
        const outbox = await transaction.db.select().from(outboxEvents);
        return {
          runs: runs.filter(({ id }) => id === startedBody.run.id).length,
          checkpoints: checkpoints.filter(
            ({ workflowRunId }) => workflowRunId === startedBody.run.id,
          ).length,
          events: events.filter(
            ({ workflowRunId }) => workflowRunId === startedBody.run.id,
          ).length,
          outbox: outbox.filter(
            ({ aggregateId }) => aggregateId === startedBody.run.id,
          ).length,
        };
      },
    );
    expect(durableRunEffects).toEqual({
      runs: 1,
      checkpoints: 1,
      events: 2,
      outbox: 2,
    });

    const storedSession = await caseFixture.application
      .get<IdentitySessionAuthority>(SESSION_AUTHORITY)
      .authenticate(cookies.rawSession);
    const streamAbort = new AbortController();
    const frames = await caseFixture.application
      .get(StreamRunEventsUseCase)
      .execute({
        actor: createActorContext({
          actorId: storedSession.userId,
          workspaceId: workspace.id,
          sessionId: storedSession.sessionId,
          requestId: 'workflow-run-stream-proof',
        }),
        routeWorkspaceId: workspace.id,
        runId: startedBody.run.id,
        lastEventId: 1,
        sessionExpiresAt: storedSession.expiresAt,
        reauthorizeSession: () =>
          Promise.resolve({
            userId: storedSession.userId,
            sessionId: storedSession.sessionId,
            expiresAt: storedSession.expiresAt,
          }),
        abortStream: (reason?: unknown) => {
          streamAbort.abort(reason);
        },
        signal: streamAbort.signal,
      });
    const iterator = frames[Symbol.asyncIterator]();
    let event: IteratorResult<unknown>;
    try {
      event = await withTimeout(iterator.next(), 2_000);
    } finally {
      streamAbort.abort();
      if (iterator.return !== undefined)
        await withTimeout(iterator.return(), 2_000);
    }
    const eventValue = event.value as Readonly<{
      id: number;
      event: string;
      data: string;
    }>;
    expect(eventValue).toMatchObject({
      id: 2,
      event: 'run.cancel_requested',
    });
    expect(eventValue.data).not.toContain('operator request');

    const hiddenRun = await caseFixture.application.inject({
      method: 'GET',
      url: `/v1/workspaces/${randomUUID()}/runs/${startedBody.run.id}`,
      headers: { cookie: cookies.cookieHeader },
    });
    expectProblem(hiddenRun, 404, 'resource.not_found');

    const hidden = await caseFixture.application.inject({
      method: 'GET',
      url: `/v1/workspaces/${randomUUID()}/workflows`,
      headers: { cookie: cookies.cookieHeader },
    });
    expectProblem(hidden, 404, 'resource.not_found');
  });
  const { login: login3, workspaceAggregate } = caseFixture;

  it('enforces CSRF and atomically creates an owner membership and correlated audit fact', async () => {
    const cookies = await login3();
    const slug = `phase1-${randomUUID().slice(0, 12)}`;
    const missingCsrf = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { cookie: cookies.cookieHeader },
      payload: { name: 'Rejected Workspace', slug: `${slug}-rejected` },
    });
    expectProblem(missingCsrf, 403, 'auth.forbidden');

    const requestId = `phase1-create-${randomUUID()}`;
    const traceId = randomUUID().replaceAll('-', '');
    const creationKey = `create-${randomUUID()}`;
    const created = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies, {
        'x-request-id': requestId,
        'idempotency-key': creationKey,
        traceparent: `00-${traceId}-0123456789abcdef-01`,
      }),
      payload: { name: 'Phase One Workspace', slug },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['x-request-id']).toBe(requestId);
    const workspace = created.json<{ id: string; status: string }>();
    expect(workspace.status).toBe('active');

    const discovered = await caseFixture.application.inject({
      method: 'GET',
      url: '/v1/workspaces?limit=100',
      headers: { cookie: cookies.cookieHeader },
    });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.headers['cache-control']).toBe('private, no-store');
    const discoveredItems = discovered.json<{
      items: { id: string; role: string; capabilities: string[] }[];
    }>().items;
    const discoveredWorkspace = discoveredItems.find(
      (item) => item.id === workspace.id,
    );
    expect(discoveredWorkspace).toMatchObject({
      id: workspace.id,
      role: 'owner',
    });
    expect(discoveredWorkspace?.capabilities).toEqual(
      expect.arrayContaining(['workspace:manage', 'workflow:create']),
    );

    const creationRetry = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies, {
        'idempotency-key': creationKey,
      }),
      payload: { name: 'Phase One Workspace', slug },
    });
    expect(creationRetry.statusCode).toBe(201);
    expect(creationRetry.json()).toEqual(created.json());
    const changedCreation = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies, {
        'idempotency-key': creationKey,
      }),
      payload: { name: 'Changed Workspace', slug },
    });
    expectProblem(changedCreation, 409, 'request.idempotency_conflict');

    const aggregate = await workspaceAggregate(workspace.id);
    expect(aggregate.memberships).toHaveLength(1);
    expect(aggregate.memberships[0]).toMatchObject({ role: 'owner' });
    expect(aggregate.events).toHaveLength(2);
    expect(aggregate.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'workspace.created',
          requestId,
          traceId,
        }),
        expect.objectContaining({
          action: 'workspace.member_added',
          requestId,
          traceId,
          targetType: 'workspace_member',
          targetId: aggregate.memberships[0]?.userId,
          metadata: {
            source: 'workspace_creation',
            role: 'owner',
            status: 'active',
            roleRevision: 1,
          },
        }),
      ]),
    );

    const duplicate = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies),
      payload: { name: 'Duplicate Workspace', slug },
    });
    expectProblem(duplicate, 409, 'workspace.conflict');
    const unchanged = await workspaceAggregate(workspace.id);
    expect(unchanged.memberships).toHaveLength(1);
    expect(unchanged.events).toHaveLength(2);
    expect(unchanged.events).toEqual(expect.arrayContaining(aggregate.events));

    const forgedRole = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies),
      payload: { name: 'Forged Role', slug: `${slug}-forged`, role: 'owner' },
    });
    expectProblem(forgedRole, 400, 'request.invalid');

    const forgedWorkspace = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${randomUUID()}/deletion`,
      headers: mutationHeaders(cookies),
      payload: { reason: 'forged workspace context' },
    });
    expectProblem(forgedWorkspace, 403, 'auth.forbidden');
  });
  const {
    login: login4,
    createWorkspace,
    workspaceAggregate: workspaceAggregate2,
  } = caseFixture;

  it('conditionally renames a workspace and safely reconciles lost acknowledgements', async () => {
    const cookies = await login4();
    const targetId = await createWorkspace(cookies, 'Rename proof');
    const firstKey = `rename-${randomUUID()}`;
    const missingCsrf = await caseFixture.application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: {
        cookie: cookies.cookieHeader,
        'idempotency-key': firstKey,
      },
      payload: { name: 'Rejected rename', expectedRevision: 1 },
    });
    expectProblem(missingCsrf, 403, 'auth.forbidden');

    const renamed = await caseFixture.application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies, { 'idempotency-key': firstKey }),
      payload: { name: 'Authoritative rename', expectedRevision: 1 },
    });
    expect(renamed.statusCode, renamed.payload).toBe(200);
    expect(renamed.json()).toMatchObject({
      workspace: {
        id: targetId,
        name: 'Authoritative rename',
        revision: 2,
      },
      changed: true,
      replayed: false,
    });
    const exactRetry = await caseFixture.application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies, { 'idempotency-key': firstKey }),
      payload: { name: 'Authoritative rename', expectedRevision: 1 },
    });
    expect(exactRetry.statusCode, exactRetry.payload).toBe(200);
    expect(exactRetry.json()).toMatchObject({ replayed: true });

    const newer = await caseFixture.application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies),
      payload: { name: 'Newer tab rename', expectedRevision: 2 },
    });
    expect(newer.statusCode, newer.payload).toBe(200);
    const historicalRetry = await caseFixture.application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies, { 'idempotency-key': firstKey }),
      payload: { name: 'Authoritative rename', expectedRevision: 1 },
    });
    expect(historicalRetry.statusCode, historicalRetry.payload).toBe(200);
    expect(historicalRetry.json()).toMatchObject({ replayed: true });

    const discovery = await caseFixture.application.inject({
      method: 'GET',
      url: '/v1/workspaces?limit=100',
      headers: { cookie: cookies.cookieHeader },
    });
    expect(
      discovery
        .json<{ items: { id: string; name: string; revision: number }[] }>()
        .items.find((item) => item.id === targetId),
    ).toMatchObject({ name: 'Newer tab rename', revision: 3 });
    const stale = await caseFixture.application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies),
      payload: { name: 'Stale overwrite', expectedRevision: 2 },
    });
    expectProblem(stale, 412, 'workspace.revision_conflict');
    const changedExactRetry = await caseFixture.application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies, { 'idempotency-key': firstKey }),
      payload: { name: 'Changed command', expectedRevision: 1 },
    });
    expectProblem(changedExactRetry, 409, 'request.idempotency_conflict');
  });

  it('applies a deletion request at once and restores it during recovery', async () => {
    const deletionCookies = await login4();
    const primaryWorkspaceId = await createWorkspace(
      deletionCookies,
      'Deletion Proof',
    );
    const deletionRequestId = `phase1-delete-${randomUUID()}`;
    const deletionKey = `delete-${randomUUID()}`;
    const deletion = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${primaryWorkspaceId}/deletion`,
      headers: mutationHeaders(deletionCookies, {
        'x-request-id': deletionRequestId,
        'idempotency-key': deletionKey,
      }),
      payload: { reason: 'customer requested integration deletion' },
    });
    expect(deletion.statusCode).toBe(200);
    expect(deletion.json()).toEqual({
      workspaceId: primaryWorkspaceId,
      change: 'deletion_requested',
      occurredAt: expect.any(String) as string,
    });
    expect(deletion.payload).not.toContain(
      'customer requested integration deletion',
    );

    // Deletion signs out the workspace's members.
    const signedOut = await caseFixture.application.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: { cookie: deletionCookies.cookieHeader },
    });
    expect(signedOut.statusCode).toBe(401);
    const cookies = await login4();

    const deletionRetry = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${primaryWorkspaceId}/deletion`,
      headers: mutationHeaders(cookies, { 'idempotency-key': deletionKey }),
      payload: { reason: 'customer requested integration deletion' },
    });
    expect(deletionRetry.statusCode).toBe(200);
    expect(deletionRetry.json()).toEqual(deletion.json());

    const deleted = await workspaceAggregate2(primaryWorkspaceId);
    expect(deleted.workspace).toMatchObject({
      status: 'pending_deletion',
      deletionReason: 'customer requested integration deletion',
    });
    expect(deleted.events.map(({ action }) => action).sort()).toEqual([
      'workspace.created',
      'workspace.deletion_requested',
      'workspace.member_added',
    ]);

    const changedReplay = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${primaryWorkspaceId}/deletion`,
      headers: mutationHeaders(cookies, { 'idempotency-key': deletionKey }),
      payload: { reason: 'changed deletion request' },
    });
    expectProblem(changedReplay, 409, 'request.idempotency_conflict');

    const restore = await caseFixture.application.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${primaryWorkspaceId}/deletion`,
      headers: mutationHeaders(cookies, {
        'idempotency-key': `restore-${randomUUID()}`,
      }),
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json()).toMatchObject({
      workspaceId: primaryWorkspaceId,
      change: 'deletion_restored',
    });
    expect(
      (await workspaceAggregate2(primaryWorkspaceId)).workspace,
    ).toMatchObject({ status: 'suspended', deletionReason: null });
  });
  const {
    login: login5,
    createWorkspace: createWorkspace2,
    withOwnerWorkspace: withOwnerWorkspace2,
    workspaceAggregate: workspaceAggregate3,
  } = caseFixture;

  let ownerUserId: string | undefined;

  /**
   * Deleting and restoring end sessions, so these cases need many. Sign-ins share
   * a small per-origin budget, so only the ones under test go through HTTP.
   */
  async function issuedSession(userId: string): Promise<SessionCookies> {
    const issued = await caseFixture.issueSession(userId);
    const csrf = randomBytes(32).toString('base64url');
    return {
      ...issued,
      csrf,
      cookieHeader: `${issued.cookieHeader}; pertexo_csrf=${csrf}`,
    };
  }

  async function ownerSession(): Promise<SessionCookies> {
    if (ownerUserId === undefined) {
      const me = await caseFixture.application.inject({
        method: 'GET',
        url: '/v1/users/me',
        headers: { cookie: (await login5()).cookieHeader },
      });
      ownerUserId = me.json<{ id: string }>().id;
    }
    return issuedSession(ownerUserId);
  }

  function reactivate(
    workspaceId: string,
    cookies: SessionCookies,
    idempotencyKey = `reactivate-${randomUUID()}`,
  ) {
    return caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/reactivate`,
      headers: mutationHeaders(cookies, { 'idempotency-key': idempotencyKey }),
    });
  }

  async function requestDeletion(
    workspaceId: string,
    cookies: SessionCookies,
  ): Promise<void> {
    const deletion = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/deletion`,
      headers: mutationHeaders(cookies),
      payload: { reason: 'integration reactivation proof' },
    });
    expect(deletion.statusCode, deletion.payload).toBe(200);
  }

  /** The workspace, restored, and the session that sent the restore. */
  async function deleteAndRestore(name: string) {
    const creator = await ownerSession();
    const workspaceId = await createWorkspace2(creator, name);
    await requestDeletion(workspaceId, creator);
    const restorer = await ownerSession();
    const restored = await caseFixture.application.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/deletion`,
      headers: mutationHeaders(restorer),
    });
    expect(restored.statusCode, restored.payload).toBe(200);
    return { workspaceId, restorer };
  }

  async function workspaceStatus(workspaceId: string) {
    return (await workspaceAggregate3(workspaceId)).workspace?.status;
  }

  async function reactivationAudits(workspaceId: string) {
    return (await workspaceAggregate3(workspaceId)).events.filter(
      ({ action }) => action === 'workspace.reactivated',
    );
  }

  it('signs members out on restore and lets a fresh sign-in read the suspended workspace', async () => {
    const { workspaceId, restorer } = await deleteAndRestore(
      'Restored Read Proof',
    );

    const signedOut = await caseFixture.application.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: { cookie: restorer.cookieHeader },
    });
    expect(signedOut.statusCode).toBe(401);

    const fresh = await login5();
    const listed = await caseFixture.application.inject({
      method: 'GET',
      url: '/v1/workspaces?limit=100',
      headers: { cookie: fresh.cookieHeader },
    });
    expect(listed.statusCode, listed.payload).toBe(200);
    expect(
      listed
        .json<{ items: { id: string }[] }>()
        .items.find((item) => item.id === workspaceId),
    ).toMatchObject({
      status: 'suspended',
      role: 'owner',
      capabilities: expect.arrayContaining(['workspace:manage']) as string[],
    });
    const runs = await caseFixture.application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs`,
      headers: { cookie: fresh.cookieHeader },
    });
    expect(runs.statusCode, runs.payload).toBe(200);
  });

  it('reactivates through a fresh sign-in, refuses a missing CSRF token and replays a retry', async () => {
    const { workspaceId } = await deleteAndRestore('Reactivation Proof');
    const cookies = await login5();
    const url = `/v1/workspaces/${workspaceId}/reactivate`;
    const key = `reactivate-${randomUUID()}`;

    const missingCsrf = await caseFixture.application.inject({
      method: 'POST',
      url,
      headers: { cookie: cookies.cookieHeader, 'idempotency-key': key },
    });
    expectProblem(missingCsrf, 403, 'auth.forbidden');
    const unauthenticated = await caseFixture.application.inject({
      method: 'POST',
      url,
      headers: { 'idempotency-key': key },
    });
    expectProblem(unauthenticated, 401, 'auth.unauthenticated');
    expect(await workspaceStatus(workspaceId)).toBe('suspended');

    const reactivated = await reactivate(workspaceId, cookies, key);
    expect(reactivated.statusCode, reactivated.payload).toBe(200);
    expect(reactivated.json()).toEqual({
      workspaceId,
      change: 'reactivated',
      occurredAt: expect.any(String) as string,
    });
    expect(await workspaceStatus(workspaceId)).toBe('active');
    expect(await reactivationAudits(workspaceId)).toHaveLength(1);

    const retry = await reactivate(workspaceId, cookies, key);
    expect(retry.statusCode, retry.payload).toBe(200);
    expect(retry.json()).toEqual(reactivated.json());
    expect(await reactivationAudits(workspaceId)).toHaveLength(1);

    // Reactivating signs nobody out, and the workspace takes work again.
    const created = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/workflows`,
      headers: mutationHeaders(cookies),
      payload: { name: 'Allowed once active' },
    });
    expect(created.statusCode, created.payload).toBe(201);
  });

  it('refuses every role but owner', async () => {
    const { workspaceId } = await deleteAndRestore('Reactivation Roles');
    for (const role of ['admin', 'builder', 'operator', 'viewer']) {
      const userId = randomUUID();
      await withOwnerWorkspace2(workspaceId, async (client) => {
        await client.query(
          `insert into app.users(id,email,display_name) values($1,$2,$3)`,
          [userId, `${userId}@example.test`, role],
        );
        await client.query(
          `insert into app.workspace_memberships(workspace_id,user_id,role)
           values($1,$2,$3)`,
          [workspaceId, userId, role],
        );
      });

      expectProblem(
        await reactivate(workspaceId, await issuedSession(userId)),
        403,
        'auth.forbidden',
      );
    }
    expect(await workspaceStatus(workspaceId)).toBe('suspended');
    expect(await reactivationAudits(workspaceId)).toEqual([]);
  });

  it('refuses a workspace that is not suspended', async () => {
    const creator = await ownerSession();
    const active = await createWorkspace2(creator, 'Reactivation Active');
    expectProblem(await reactivate(active, creator), 409, 'workspace.conflict');
    expect(await workspaceStatus(active)).toBe('active');

    await requestDeletion(active, creator);
    expectProblem(
      await reactivate(active, await ownerSession()),
      409,
      'workspace.conflict',
    );
    expect(await workspaceStatus(active)).toBe('pending_deletion');

    // As for Restore, the route's guard hides the last two states.
    await withOwnerWorkspace2(active, (client) =>
      client.query(`update app.workspaces set status='purging' where id=$1`, [
        active,
      ]),
    );
    expectProblem(
      await reactivate(active, await ownerSession()),
      403,
      'auth.forbidden',
    );
    await withOwnerWorkspace2(active, (client) =>
      client.query(
        `update app.workspaces
         set status='deleted', created_by=null, deletion_requested_by=null,
             deletion_reason='purged', name='Deleted workspace',
             slug='deleted-'||id
         where id=$1`,
        [active],
      ),
    );
    expectProblem(
      await reactivate(active, await ownerSession()),
      403,
      'auth.forbidden',
    );
    expect(await workspaceStatus(active)).toBe('deleted');
    expect(await reactivationAudits(active)).toEqual([]);
  });
  const {
    login: login6,
    createWorkspace: createWorkspace3,
    ownerEmail,
    withOwnerWorkspace: withOwnerWorkspace3,
    createPublishedWorkflow: createPublishedWorkflow3,
    issueSession,
    authenticatedMutation,
  } = caseFixture;

  it('serves a private current-user projection and bounded authorized member pages', async () => {
    const cookies = await login6();
    const primaryWorkspaceId = await createWorkspace3(cookies, 'Member Proof');
    const unauthenticated = await caseFixture.application.inject({
      method: 'GET',
      url: '/v1/users/me',
    });
    expectProblem(unauthenticated, 401, 'auth.unauthenticated');
    const profile = await caseFixture.application.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { cookie: cookies.cookieHeader },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.headers['cache-control']).toBe('private, no-store');
    expect(profile.json()).toMatchObject({
      email: ownerEmail,
      displayName: 'Phase One Real Stack',
      status: 'active',
    });
    expect(profile.json()).not.toHaveProperty('profileMetadata');

    const memberA = await caseFixture.identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Member A',
    });
    const memberB = await caseFixture.identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Member B',
    });
    await withOwnerWorkspace3(primaryWorkspaceId, (client) =>
      client.query(
        `insert into app.workspace_memberships (workspace_id, user_id, role, status)
         values ($1, $2, 'viewer', 'active'), ($1, $3, 'viewer', 'active')`,
        [primaryWorkspaceId, memberA.id, memberB.id],
      ),
    );

    const first = await caseFixture.application.inject({
      method: 'GET',
      url: `/v1/workspaces/${primaryWorkspaceId}/members?limit=1`,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    const firstBody = first.json<{
      items: unknown[];
      nextCursor: string | null;
    }>();
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.nextCursor).toBeTruthy();
    const second = await caseFixture.application.inject({
      method: 'GET',
      url: `/v1/workspaces/${primaryWorkspaceId}/members?limit=1&after=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(
      second.json<{ items: { userId: string }[] }>().items[0]?.userId,
    ).not.toBe((firstBody.items[0] as { userId: string }).userId);

    const crossTenant = await caseFixture.application.inject({
      method: 'GET',
      url: `/v1/workspaces/${randomUUID()}/members`,
      headers: { cookie: cookies.cookieHeader },
    });
    expectProblem(crossTenant, 403, 'auth.forbidden');

    const { base, createdBody } = await createPublishedWorkflow3(
      cookies,
      primaryWorkspaceId,
    );
    const started = await caseFixture.application.inject({
      method: 'POST',
      url: `${base}/${createdBody.workflow.id}/runs`,
      headers: mutationHeaders(cookies, {
        'idempotency-key': `role-revocation-run-${randomUUID()}`,
      }),
      payload: { input: { source: 'role-revocation-proof' } },
    });
    expect(started.statusCode, started.payload).toBe(202);
    const runId = started.json<{ run: { id: string } }>().run.id;
    const runUrl = `/v1/workspaces/${primaryWorkspaceId}/runs/${runId}`;

    const targetCookie = (await issueSession(memberA.id)).cookieHeader;
    const beforeChange = await caseFixture.application.inject({
      method: 'GET',
      url: runUrl,
      headers: { cookie: targetCookie },
    });
    expect(beforeChange.statusCode, beforeChange.payload).toBe(200);

    await caseFixture.application.listen(0, '127.0.0.1');
    const address = caseFixture.application.getHttpServer().address() as {
      port: number;
    };
    const openStream = openHttpEventStream(
      address.port,
      `${runUrl}/events`,
      targetCookie,
      1,
    );
    await withTimeout(openStream.started, 2_000);

    const roleHeaders = mutationHeaders(cookies, {
      'idempotency-key': `member-role-${randomUUID()}`,
    });
    try {
      const roleChange = await caseFixture.application.inject({
        method: 'POST',
        url: `/v1/workspaces/${primaryWorkspaceId}/members/${memberA.id}/role`,
        headers: roleHeaders,
        payload: { role: 'operator', expectedRoleRevision: 1 },
      });
      expect(roleChange.statusCode).toBe(200);
      expect(roleChange.json()).toEqual({
        userId: memberA.id,
        role: 'operator',
        roleRevision: 2,
        changed: true,
        replayed: false,
      });
      const afterChange = await caseFixture.application.inject({
        method: 'GET',
        url: runUrl,
        headers: { cookie: targetCookie },
      });
      expectProblem(afterChange, 401, 'auth.unauthenticated');
      await withTimeout(openStream.closed, 6_500);
    } finally {
      openStream.request.destroy();
    }
    const replay = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${primaryWorkspaceId}/members/${memberA.id}/role`,
      headers: roleHeaders,
      payload: { role: 'operator', expectedRoleRevision: 1 },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, roleRevision: 2 });
    const stale = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${primaryWorkspaceId}/members/${memberA.id}/role`,
      headers: mutationHeaders(cookies),
      payload: { role: 'viewer', expectedRoleRevision: 1 },
    });
    expectProblem(stale, 409, 'workspace.member_role_revision_conflict');
  }, 15_000);

  it('rejects a revoked session without exposing its cookie value', async () => {
    const logoutCookies = await login6();
    const logout = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: mutationHeaders(logoutCookies),
    });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
    const afterLogout = await authenticatedMutation(logoutCookies);
    expectProblem(afterLogout, 401, 'auth.unauthenticated');
    expect(afterLogout.payload).not.toContain(logoutCookies.rawSession);
  });
  const {
    signUp,
    signIn,
    createWorkspace: createWorkspace4,
    createPublishedWorkflow: createPublishedWorkflow4,
    withOwnerWorkspace: withOwnerWorkspace4,
    workspaceAggregate: workspaceAggregate4,
  } = caseFixture;

  it('accepts a delivered invitation once, rotates the recipient session, and closes an existing SSE stream', async () => {
    const managerEmail = `${randomUUID()}@example.test`;
    await signUp(managerEmail, 'Invitation integration manager');
    const managerCookies = await signIn(managerEmail);
    const invitedWorkspaceId = await createWorkspace4(
      managerCookies,
      'Invitation acceptance proof',
    );
    const streamWorkspaceId = await createWorkspace4(
      managerCookies,
      'Invitation stream proof',
    );
    const { base, createdBody } = await createPublishedWorkflow4(
      managerCookies,
      streamWorkspaceId,
    );
    const started = await caseFixture.application.inject({
      method: 'POST',
      url: `${base}/${createdBody.workflow.id}/runs`,
      headers: mutationHeaders(managerCookies, {
        'idempotency-key': `invitation-run-${randomUUID()}`,
      }),
      payload: { input: { source: 'invitation-session-proof' } },
    });
    expect(started.statusCode, started.payload).toBe(202);
    const runId = started.json<{ run: { id: string } }>().run.id;
    const runUrl = `/v1/workspaces/${streamWorkspaceId}/runs/${runId}`;
    const recipientEmail = `${randomUUID()}@example.test`;
    const createdInvitation = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${invitedWorkspaceId}/invitations`,
      headers: mutationHeaders(managerCookies, {
        'idempotency-key': `invitation-create-${randomUUID()}`,
      }),
      payload: { email: recipientEmail, role: 'viewer' },
    });
    expect(createdInvitation.statusCode, createdInvitation.payload).toBe(202);
    const invitationId = createdInvitation.json<{
      invitation: { id: string };
    }>().invitation.id;
    let invitationToken = '';
    await withOwnerWorkspace4(invitedWorkspaceId, async (client) => {
      const delivery = await client.query<{
        id: string;
        token_ciphertext: string;
        token_nonce: string;
        token_tag: string;
        token_key_version: string;
      }>(
        `select id,token_ciphertext,token_nonce,token_tag,token_key_version
           from app.workspace_invitation_delivery_attempts
          where workspace_id=$1 and invitation_id=$2`,
        [invitedWorkspaceId, invitationId],
      );
      const row = delivery.rows[0];
      if (row === undefined)
        throw new Error('Invitation delivery was not stored');
      invitationToken = createApplicationSecretEnvelope(invitationKeys).open(
        {
          ciphertext: row.token_ciphertext,
          nonce: row.token_nonce,
          tag: row.token_tag,
          keyVersion: row.token_key_version,
        },
        `pertexo/workspace-invitation/${invitedWorkspaceId}/${invitationId}/${row.id}`,
      );
    });

    const resolved = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/invitation-acceptance/resolve',
      remoteAddress: '198.51.100.25',
      headers: {
        origin: 'https://api.integration.test',
        'content-type': 'application/json',
        'x-pertexo-invitation-request': 'resolve',
      },
      payload: { token: invitationToken },
    });
    expect(resolved.statusCode, resolved.payload).toBe(201);
    let resolvedBody = resolved.json<{
      state: string;
      intentId: string;
      csrfToken: string;
    }>();
    expect(resolvedBody.state).toBe('sign_in_required');
    const originalInvitationBinding = cookieValue(
      Array.isArray(resolved.headers['set-cookie'])
        ? resolved.headers['set-cookie']
        : [String(resolved.headers['set-cookie'])],
      'pertexo_invitation_intent',
    );
    const lostReplacement = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/invitation-acceptance/resolve',
      remoteAddress: '198.51.100.25',
      headers: {
        cookie: `pertexo_invitation_intent=${encodeURIComponent(originalInvitationBinding)}`,
        origin: 'https://api.integration.test',
        'content-type': 'application/json',
        'x-pertexo-invitation-request': 'resolve',
      },
      payload: { token: invitationToken },
    });
    expect(lostReplacement.statusCode, lostReplacement.payload).toBe(201);
    const lostReplacementBody = lostReplacement.json<{
      state: string;
      intentId: string;
      csrfToken: string;
    }>();
    const lostReplacementBinding = cookieValue(
      Array.isArray(lostReplacement.headers['set-cookie'])
        ? lostReplacement.headers['set-cookie']
        : [String(lostReplacement.headers['set-cookie'])],
      'pertexo_invitation_intent',
    );
    const recoveredReplacement = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/invitation-acceptance/resolve',
      remoteAddress: '198.51.100.25',
      headers: {
        cookie: `pertexo_invitation_intent=${encodeURIComponent(originalInvitationBinding)}`,
        origin: 'https://api.integration.test',
        'content-type': 'application/json',
        'x-pertexo-invitation-request': 'resolve',
      },
      payload: { token: invitationToken },
    });
    expect(recoveredReplacement.statusCode, recoveredReplacement.payload).toBe(
      201,
    );
    expect(recoveredReplacement.json()).toEqual(lostReplacementBody);
    const invitationBinding = cookieValue(
      Array.isArray(recoveredReplacement.headers['set-cookie'])
        ? recoveredReplacement.headers['set-cookie']
        : [String(recoveredReplacement.headers['set-cookie'])],
      'pertexo_invitation_intent',
    );
    expect(invitationBinding).toBe(lostReplacementBinding);
    resolvedBody = lostReplacementBody;
    await signUp(recipientEmail, 'Invited integration recipient');
    let openStream: ReturnType<typeof openHttpEventStream> | undefined;
    try {
      const recipientCookies = await signIn(recipientEmail);
      const recipientId = (
        await caseFixture.application
          .get<IdentitySessionAuthority>(SESSION_AUTHORITY)
          .authenticate(recipientCookies.rawSession)
      ).userId;
      await withOwnerWorkspace4(streamWorkspaceId, (client) =>
        client.query(
          `insert into app.workspace_memberships(workspace_id,user_id,role,status)
           values($1,$2,'viewer','active')`,
          [streamWorkspaceId, recipientId],
        ),
      );
      const beforeAcceptance = await caseFixture.application.inject({
        method: 'GET',
        url: runUrl,
        headers: { cookie: recipientCookies.cookieHeader },
      });
      expect(beforeAcceptance.statusCode, beforeAcceptance.payload).toBe(200);
      if (!caseFixture.application.getHttpServer().listening)
        await caseFixture.application.listen(0, '127.0.0.1');
      const address = caseFixture.application.getHttpServer().address() as {
        port: number;
      };
      openStream = openHttpEventStream(
        address.port,
        `${runUrl}/events`,
        recipientCookies.cookieHeader,
        1,
      );
      await withTimeout(openStream.started, 2_000);

      const ready = await caseFixture.application.inject({
        method: 'POST',
        url: '/v1/invitation-acceptance/session',
        headers: mutationHeaders(recipientCookies, {
          cookie: `${recipientCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
          'x-invitation-csrf-token': resolvedBody.csrfToken,
        }),
        payload: {},
      });
      expect(ready.statusCode, ready.payload).toBe(200);
      const readyBody = ready.json<{
        state: string;
        intentId: string;
        csrfToken: string;
        invitationRevision: number;
      }>();
      expect(readyBody).toMatchObject({
        state: 'ready',
        intentId: resolvedBody.intentId,
        csrfToken: resolvedBody.csrfToken,
        invitationRevision: 1,
      });
      const acceptanceKey = `invitation-accept-${randomUUID()}`;
      const completed = await caseFixture.application.inject({
        method: 'POST',
        url: '/v1/invitation-acceptance/complete',
        headers: mutationHeaders(recipientCookies, {
          cookie: `${recipientCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
          'idempotency-key': acceptanceKey,
          'x-invitation-csrf-token': readyBody.csrfToken,
        }),
        payload: {
          intentId: readyBody.intentId,
          expectedRevision: readyBody.invitationRevision,
        },
      });
      expect(completed.statusCode, completed.payload).toBe(200);
      expect(completed.json()).toMatchObject({
        workspaceId: invitedWorkspaceId,
        membershipCreated: true,
        role: 'viewer',
      });
      const replacementCookies = sessionCookies(
        completed.headers['set-cookie'],
      );
      expect(String(completed.headers['set-cookie'])).not.toContain(
        'pertexo_invitation_intent=;',
      );
      const reconciledWithReplacement = await caseFixture.application.inject({
        method: 'GET',
        url: '/v1/invitation-acceptance',
        headers: {
          cookie: `${replacementCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
        },
      });
      expect(reconciledWithReplacement.statusCode).toBe(200);
      expect(reconciledWithReplacement.json()).toMatchObject({
        state: 'completed',
        workspace: { id: invitedWorkspaceId },
      });
      const oldSession = await caseFixture.application.inject({
        method: 'GET',
        url: runUrl,
        headers: { cookie: recipientCookies.cookieHeader },
      });
      expectProblem(oldSession, 401, 'auth.unauthenticated');
      await withTimeout(openStream.closed, 6_500);

      const recoveryRequired = await caseFixture.application.inject({
        method: 'GET',
        url: '/v1/invitation-acceptance',
        headers: {
          cookie: `pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
        },
      });
      expect(recoveryRequired.statusCode, recoveryRequired.payload).toBe(200);
      expect(recoveryRequired.json()).toMatchObject({
        state: 'sign_in_required',
        intentId: readyBody.intentId,
      });

      const recoveredCookies = await signIn(recipientEmail);
      const reconciledAfterLostCookies = await caseFixture.application.inject({
        method: 'GET',
        url: '/v1/invitation-acceptance',
        headers: {
          cookie: `${recoveredCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
        },
      });
      expect(reconciledAfterLostCookies.statusCode).toBe(200);
      expect(reconciledAfterLostCookies.json()).toMatchObject({
        state: 'completed',
        workspace: { id: invitedWorkspaceId },
      });
      const changedExactRetry = await caseFixture.application.inject({
        method: 'POST',
        url: '/v1/invitation-acceptance/complete',
        headers: mutationHeaders(recoveredCookies, {
          cookie: `${recoveredCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
          'idempotency-key': acceptanceKey,
          'x-invitation-csrf-token': readyBody.csrfToken,
        }),
        payload: {
          intentId: readyBody.intentId,
          expectedRevision: readyBody.invitationRevision + 1,
        },
      });
      expectProblem(changedExactRetry, 409, 'request.idempotency_conflict');
      const historicalRecovery = await caseFixture.application.inject({
        method: 'POST',
        url: '/v1/invitation-acceptance/complete',
        headers: mutationHeaders(recoveredCookies, {
          cookie: `${recoveredCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
          'idempotency-key': `invitation-recovery-${randomUUID()}`,
          'x-invitation-csrf-token': readyBody.csrfToken,
        }),
        payload: {
          intentId: readyBody.intentId,
          expectedRevision: readyBody.invitationRevision + 1,
        },
      });
      expect(historicalRecovery.statusCode, historicalRecovery.payload).toBe(
        200,
      );
      expect(historicalRecovery.json()).toMatchObject({
        replayed: true,
        membershipCreated: true,
      });
      const granted = await caseFixture.application.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: { cookie: replacementCookies.cookieHeader },
      });
      expect(granted.statusCode, granted.payload).toBe(200);
      expect(
        granted
          .json<{ items: { id: string; role: string }[] }>()
          .items.find((item) => item.id === invitedWorkspaceId),
      ).toMatchObject({ id: invitedWorkspaceId, role: 'viewer' });
      const aggregate = await workspaceAggregate4(invitedWorkspaceId);
      expect(
        aggregate.events.filter(
          (event) => event.action === 'workspace.invitation_accepted',
        ),
      ).toHaveLength(1);
    } finally {
      openStream?.request.destroy();
    }
  }, 20_000);
});
