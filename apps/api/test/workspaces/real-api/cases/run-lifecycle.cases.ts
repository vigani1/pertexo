import { randomUUID } from 'node:crypto';
import {
  outboxEvents,
  runCheckpoints,
  runEvents,
  workflowRuns,
} from '@pertexo/database/testing';
import {
  workflowRunListResponseSchema,
  workflowRunStatisticsResponseSchema,
} from '@pertexo/contracts';
import { expect, it } from 'vitest';
import {
  SESSION_AUTHORITY,
  type IdentitySessionAuthority,
} from '../../../../src/workspaces/index.js';
import { createActorContext } from '../../../../src/authorization/index.js';
import { StreamRunEventsUseCase } from '../../../../src/workflow-runs/index.js';
import { mutationHeaders } from '../cookies.js';
import { withTimeout } from '../streams.js';
import { expectProblem } from '../assertions.js';
import type { createWorkspaceApiFixture } from '../fixture.js';

export function registerStartsReplaysReadsCancelsStreamsDurableWorkflow(
  caseFixture: ReturnType<typeof createWorkspaceApiFixture>,
): void {
  const {
    login,
    createPublishedWorkflow,
    withOwnerWorkspace,
    archiveWorkflow,
  } = caseFixture;

  it('starts, replays, reads, cancels, and streams a durable workflow run', async () => {
    let cookies = await login();
    const { workspace, base, createdBody, publishedBody } =
      await createPublishedWorkflow(cookies);

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
        const denied = await login();
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
    cookies = await login();

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
}
