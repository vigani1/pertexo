import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  authorizeWorkspace,
  createActorContext,
} from '../../../src/authorization/index.js';
import {
  GetWorkflowRunUseCase,
  StartWorkflowRunUseCase,
} from '../../../src/workflow-runs/use-cases.js';

import {
  actorId,
  sessionId,
  workspaceId,
  workflowId,
  workflowVersionId,
  runId,
  now,
  actor,
  authorization,
  persistence,
  startCommand,
  replayCommand,
} from './fixture.js';

export function registerReusesGuardAuthorizationWithoutRepeatingAccess(): void {
  it('reuses guard authorization without repeating the access lookup', async () => {
    const fixture = persistence();
    const access = authorization();
    const authorizedWorkspace = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      capability: 'run:read',
      access,
      disclosure: 'not_found',
    });

    await new GetWorkflowRunUseCase(fixture.store, access).execute({
      actor,
      routeWorkspaceId: workspaceId,
      authorizedWorkspace,
      runId,
    });

    expect(access.findAccess).toHaveBeenCalledTimes(1);
  });

  it('authorizes and canonicalizes one idempotent start command', async () => {
    const fixture = persistence();
    const useCase = new StartWorkflowRunUseCase(fixture.store, authorization());

    const result = await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      idempotencyKey: 'run-start-42',
      input: { b: 2, a: 1 },
      deadlineAt: '2026-08-21T18:00:00.000Z',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    });

    expect(result.run.id).toBe(runId);
    expect(result.run.createdAt).toBe(now.toISOString());
    expect(result.replayed).toBe(false);
    const command = fixture.start.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      actorId,
      workspaceId,
      workflowId,
      scope: `workflow:${workflowId}:manual`,
      input: { b: 2, a: 1 },
      deadlineAt: new Date('2026-08-21T18:00:00.000Z'),
      requestId: 'request-42',
      traceId: 'trace-42',
    });
    expect(command?.idempotencyKeyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(command?.requestHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('canonically hashes start commands and excludes request metadata', async () => {
    const canonical = await startCommand({ input: { a: 1, b: 2 } });
    const reordered = await startCommand({ input: { b: 2, a: 1 } });
    const metadataOnly = await startCommand({
      input: { a: 1, b: 2 },
      requestId: 'different-request',
      traceId: 'different-trace',
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    });

    expect(reordered.requestHash).toBe(canonical.requestHash);
    expect(metadataOnly.requestHash).toBe(canonical.requestHash);
    expect(reordered.idempotencyKeyHash).toBe(canonical.idempotencyKeyHash);
  });

  it('hashes the sole start shape and binds only explicit publication expectations', async () => {
    const unchecked = await startCommand({ input: { a: 1 } });
    const expectedHash = createHash('sha256')
      .update(
        JSON.stringify({
          actorId,
          domain: 'pertexo.workflow-run.start-request',
          input: { a: 1 },
          workflowId,
          workspaceId,
        }),
      )
      .digest('hex');
    expect(unchecked.requestHash).toBe(expectedHash);
    expect(unchecked).not.toHaveProperty('expectedPublishedVersionId');
    const checked = await startCommand({
      input: { a: 1 },
      expectedPublishedVersionId: workflowVersionId,
    });
    expect(checked.expectedPublishedVersionId).toBe(workflowVersionId);
    expect(checked.requestHash).not.toBe(unchecked.requestHash);
    const changed = await startCommand({
      input: { a: 1 },
      expectedPublishedVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(changed.requestHash).not.toBe(checked.requestHash);
  });

  it('separates every start hash authority field and absent input from null', async () => {
    const otherActor = createActorContext({
      actorId: '11111111-1111-4111-8111-111111111111',
      workspaceId,
      sessionId,
      requestId: 'request-42',
    });
    const otherWorkspaceId = '22222222-2222-4222-8222-222222222222';
    const otherWorkspaceActor = createActorContext({
      actorId,
      workspaceId: otherWorkspaceId,
      sessionId,
      requestId: 'request-42',
    });
    const baseline = await startCommand();
    const variants = await Promise.all([
      startCommand({ actor: otherActor }),
      startCommand({
        actor: otherWorkspaceActor,
        routeWorkspaceId: otherWorkspaceId,
      }),
      startCommand({ workflowId: '33333333-3333-4333-8333-333333333333' }),
      startCommand({ input: null }),
      startCommand({ input: { changed: true } }),
      startCommand({ deadlineAt: '2026-08-21T18:00:00.000Z' }),
    ]);

    expect(new Set(variants.map((command) => command.requestHash)).size).toBe(
      variants.length,
    );
    for (const variant of variants) {
      expect(variant.requestHash).not.toBe(baseline.requestHash);
    }
  });

  it('canonically hashes replay commands and excludes request metadata', async () => {
    const canonical = await replayCommand();
    const reordered = await replayCommand({ input: { b: 2, a: 1 } });
    const metadataOnly = await replayCommand({
      requestId: 'different-request',
      traceId: 'different-trace',
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    });

    expect(reordered.requestHash).toBe(canonical.requestHash);
    expect(metadataOnly.requestHash).toBe(canonical.requestHash);
    expect(reordered.idempotencyKeyHash).toBe(canonical.idempotencyKeyHash);
  });

  it('separates every replay hash authority field', async () => {
    const otherActor = createActorContext({
      actorId: '11111111-1111-4111-8111-111111111111',
      workspaceId,
      sessionId,
      requestId: 'request-42',
    });
    const otherWorkspaceId = '22222222-2222-4222-8222-222222222222';
    const otherWorkspaceActor = createActorContext({
      actorId,
      workspaceId: otherWorkspaceId,
      sessionId,
      requestId: 'request-42',
    });
    const baseline = await replayCommand();
    const variants = await Promise.all([
      replayCommand({ actor: otherActor }),
      replayCommand({
        actor: otherWorkspaceActor,
        routeWorkspaceId: otherWorkspaceId,
      }),
      replayCommand({ runId: '33333333-3333-4333-8333-333333333333' }),
      replayCommand({
        workflowVersionId: '44444444-4444-4444-8444-444444444444',
      }),
      replayCommand({ input: null }),
      replayCommand({ input: { changed: true } }),
      replayCommand({ deadlineAt: '2026-08-21T18:00:00.000Z' }),
    ]);

    expect(new Set(variants.map((command) => command.requestHash)).size).toBe(
      variants.length,
    );
    for (const variant of variants) {
      expect(variant.requestHash).not.toBe(baseline.requestHash);
    }
  });

  it('checks current start authority before recovering an accepted command', async () => {
    const fixture = persistence();
    const input = {
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      idempotencyKey: 'accepted-run-recovery',
    };
    await new StartWorkflowRunUseCase(fixture.store, authorization()).execute(
      input,
    );
    await expect(
      new StartWorkflowRunUseCase(
        fixture.store,
        authorization('viewer'),
      ).execute(input),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(fixture.start).toHaveBeenCalledTimes(1);
  });
}
