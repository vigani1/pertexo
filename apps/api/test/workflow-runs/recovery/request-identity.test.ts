import { describe, expect, it } from 'vitest';
import { recoveryRequestHash } from '../../../src/workflow-runs/recovery/use-cases.js';
import { createActorContext } from '../../../src/authorization/index.js';
const input = {
  actor: createActorContext({
    actorId: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    sessionId: '33333333-3333-4333-8333-333333333333',
    requestId: 'original',
  }),
  routeWorkspaceId: '22222222-2222-4222-8222-222222222222',
  runId: '44444444-4444-4444-8444-444444444444',
  workflowVersionId: '55555555-5555-4555-8555-555555555555',
  nodeRunId: '66666666-6666-4666-8666-666666666666',
  idempotencyKey: 'key',
};
describe('recovery command identity', () => {
  it('binds source, version, step, deadline, authority and possible-effects acknowledgement', () => {
    const original = recoveryRequestHash(input);
    for (const change of [
      { runId: '77777777-7777-4777-8777-777777777777' },
      { workflowVersionId: input.runId },
      { nodeRunId: input.runId },
      { deadlineAt: '2026-10-13T23:59:59Z' },
      { acknowledgePossibleEffects: true as const },
      { actor: { ...input.actor, actorId: input.runId } },
      { routeWorkspaceId: input.runId },
    ])
      expect(recoveryRequestHash({ ...input, ...change })).not.toBe(original);
  });
  it('does not change an uncertain intent when transport identifiers or the raw key change', () => {
    expect(
      recoveryRequestHash({
        ...input,
        requestId: 'retried',
        traceId: 'other',
        idempotencyKey: 'different-key',
      }),
    ).toBe(recoveryRequestHash(input));
  });
});
