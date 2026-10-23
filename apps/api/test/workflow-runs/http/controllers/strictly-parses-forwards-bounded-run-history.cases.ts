import { expect, it, vi } from 'vitest';

import {
  actorId,
  guardActorId,
  sessionId,
  workspaceId,
  workflowId,
  runId,
  request,
  sseReply,
  controller,
} from './fixture.js';

export function registerStrictlyParsesForwardsBoundedRunHistory(): void {
  it('strictly parses and forwards bounded run-history filters', async () => {
    const fixture = controller();
    await fixture.instance.listRuns(
      request(),
      { workspaceId },
      {
        limit: '25',
        workflowId,
        status: 'succeeded',
        createdAtFrom: '2026-08-20T00:00:00.000Z',
        createdAtBefore: '2026-08-21T00:00:00.000Z',
      },
    );
    expect(fixture.list.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        routeWorkspaceId: workspaceId,
        limit: 25,
        workflowId,
        status: 'succeeded',
      }),
    );
    await expect(
      fixture.instance.listRuns(request(), { workspaceId }, { unknown: true }),
    ).rejects.toBeDefined();
    expect(fixture.list.execute).toHaveBeenCalledTimes(1);
  });

  it('strictly parses a fixed statistics window and optional breakdown', async () => {
    const fixture = controller();
    await fixture.instance.getRunStatistics(
      request(),
      { workspaceId },
      { window: '7d', breakdown: 'workflow' },
    );
    await fixture.instance.getRunStatistics(
      request(),
      { workspaceId },
      undefined,
    );
    expect(fixture.statistics.execute).toHaveBeenNthCalledWith(1, {
      actor: expect.objectContaining({ actorId, workspaceId }) as unknown,
      routeWorkspaceId: workspaceId,
      window: '7d',
      breakdown: 'workflow',
    });
    expect(fixture.statistics.execute.mock.calls[1]?.[0]).not.toHaveProperty(
      'window',
    );
    for (const query of [
      { window: '30d' },
      { createdAtFrom: '2026-08-20T00:00:00.000Z' },
    ])
      await expect(
        fixture.instance.getRunStatistics(request(), { workspaceId }, query),
      ).rejects.toBeDefined();
    await expect(
      fixture.instance.getRunStatistics(
        request(),
        { workspaceId: 'not-a-workspace' },
        {},
      ),
    ).rejects.toBeDefined();
    expect(fixture.statistics.execute).toHaveBeenCalledTimes(2);
  });

  it('forwards distinct sub-millisecond run-history boundaries', async () => {
    const fixture = controller();
    await fixture.instance.listRuns(
      request(),
      { workspaceId },
      {
        createdAtFrom: '2026-08-21T00:00:00.000100Z',
        createdAtBefore: '2026-08-21T00:00:00.000900Z',
      },
    );

    expect(fixture.list.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAtFrom: '2026-08-21T00:00:00.000100Z',
        createdAtBefore: '2026-08-21T00:00:00.000900Z',
      }),
    );
  });

  it('uses session context without a guard and gives guarded context precedence', async () => {
    const fixture = controller();
    await fixture.instance.startRun(
      request({ 'idempotency-key': 'session-context' }),
      { workspaceId, workflowId },
      {},
    );
    expect(fixture.start.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest asymmetric matcher is intentionally untyped at this nested boundary.
        actor: expect.objectContaining({ actorId, requestId: 'request-42' }),
        requestId: 'request-42',
        traceId: 'trace-42',
      }),
    );
    expect(fixture.start.execute.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      'authorizedWorkspace',
    );

    const authorizedWorkspace = {
      actor: Object.freeze({
        actorId: guardActorId,
        kind: 'user' as const,
        workspaceId,
        sessionId,
        requestId: 'guard-request',
        traceId: 'guard-trace',
      }),
      workspaceId,
      role: 'owner' as const,
      capability: 'run:start' as const,
    };
    await fixture.instance.startRun(
      {
        ...request({ 'idempotency-key': 'guard-context' }),
        authorizedWorkspace,
      },
      { workspaceId, workflowId },
      {},
    );
    expect(fixture.start.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actor: authorizedWorkspace.actor,
        authorizedWorkspace,
        requestId: 'guard-request',
        traceId: 'guard-trace',
      }),
    );
  });

  it('passes controller-owned SSE reauthorization and authorization to the stream use case', async () => {
    const fixture = controller();
    const reply = sseReply();
    const reauthorizeIdentitySession = vi.fn(
      request().reauthorizeIdentitySession,
    );
    const authorizedWorkspace = {
      actor: Object.freeze({
        actorId: guardActorId,
        kind: 'user' as const,
        workspaceId,
        sessionId,
        requestId: 'guard-request',
      }),
      workspaceId,
      role: 'viewer' as const,
      capability: 'run:read' as const,
    };
    await fixture.instance.streamRunEvents(
      {
        ...request(),
        authorizedWorkspace,
        reauthorizeIdentitySession,
      },
      { workspaceId, runId },
      reply as never,
    );
    expect(fixture.stream.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: authorizedWorkspace.actor,
        authorizedWorkspace,
        reauthorizeSession: reauthorizeIdentitySession,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest asymmetric matcher is intentionally untyped at this nested boundary.
        abortStream: expect.any(Function),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest asymmetric matcher is intentionally untyped at this nested boundary.
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('parses one start request and forwards idempotency and trace context', async () => {
    const fixture = controller();
    await fixture.instance.startRun(
      request({
        'idempotency-key': 'run-start-42',
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      }),
      { workspaceId, workflowId },
      { input: { customerId: 'customer-42' } },
    );

    expect(fixture.start.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        routeWorkspaceId: workspaceId,
        workflowId,
        idempotencyKey: 'run-start-42',
        input: { customerId: 'customer-42' },
        requestId: 'request-42',
        traceId: 'trace-42',
      }),
    );
  });

  it('rejects a missing idempotency key before calling the start use case', async () => {
    const fixture = controller();
    await expect(
      fixture.instance.startRun(request(), { workspaceId, workflowId }, {}),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    expect(fixture.start.execute).not.toHaveBeenCalled();
  });
}
