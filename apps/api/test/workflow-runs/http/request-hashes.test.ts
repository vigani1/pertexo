import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createActorContext } from '../../../src/authorization/index.js';
import {
  replayRequestHash,
  startRequestHash,
} from '../../../src/workflow-runs/http/request-hashes.js';
import type {
  ReplayWorkflowRunInput,
  StartWorkflowRunInput,
} from '../../../src/workflow-runs/workflow-runs.service.js';

// What an idempotent start or replay is "the same request" by: a retry with
// the same key replays only when this hash matches, so a field missing here
// would let a changed command come back as the first one's receipt.
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const workflowVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const sessionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId,
  requestId: 'request-42',
  traceId: 'trace-42',
});
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

const start = (overrides: Partial<StartWorkflowRunInput> = {}) =>
  startRequestHash({
    actor,
    routeWorkspaceId: workspaceId,
    workflowId,
    idempotencyKey: 'stable-start-key',
    ...overrides,
  });

const replay = (overrides: Partial<ReplayWorkflowRunInput> = {}) =>
  replayRequestHash({
    actor,
    routeWorkspaceId: workspaceId,
    runId,
    workflowVersionId,
    idempotencyKey: 'stable-replay-key',
    input: { a: 1, b: 2 },
    ...overrides,
  });

describe('run start request hash', () => {
  it('ignores key order and request metadata', () => {
    const canonical = start({ input: { a: 1, b: 2 } });
    expect(start({ input: { b: 2, a: 1 } })).toBe(canonical);
    expect(
      start({
        input: { a: 1, b: 2 },
        actor: createActorContext({
          actorId,
          workspaceId,
          sessionId,
          requestId: 'different-request',
          traceId: 'different-trace',
        }),
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      }),
    ).toBe(canonical);
  });

  it('hashes the one start shape and binds only an explicit publication expectation', () => {
    const unchecked = start({ input: { a: 1 } });
    expect(unchecked).toBe(
      createHash('sha256')
        .update(
          JSON.stringify({
            actorId,
            domain: 'pertexo.workflow-run.start-request',
            input: { a: 1 },
            workflowId,
            workspaceId,
          }),
        )
        .digest('hex'),
    );
    const checked = start({
      input: { a: 1 },
      expectedPublishedVersionId: workflowVersionId,
    });
    expect(checked).not.toBe(unchecked);
    expect(
      start({
        input: { a: 1 },
        expectedPublishedVersionId: '33333333-3333-4333-8333-333333333333',
      }),
    ).not.toBe(checked);
  });

  it('separates every authority field and absent input from null', () => {
    const baseline = start();
    const variants = [
      start({ actor: otherActor }),
      start({ actor: otherWorkspaceActor, routeWorkspaceId: otherWorkspaceId }),
      start({ workflowId: '33333333-3333-4333-8333-333333333333' }),
      start({ input: null }),
      start({ input: { changed: true } }),
      start({ deadlineAt: '2026-08-21T18:00:00.000Z' }),
    ];
    expect(new Set([baseline, ...variants]).size).toBe(variants.length + 1);
  });
});

describe('run replay request hash', () => {
  it('ignores key order and request metadata', () => {
    const canonical = replay();
    expect(replay({ input: { b: 2, a: 1 } })).toBe(canonical);
    expect(
      replay({
        actor: createActorContext({
          actorId,
          workspaceId,
          sessionId,
          requestId: 'different-request',
          traceId: 'different-trace',
        }),
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      }),
    ).toBe(canonical);
  });

  it('separates every authority field', () => {
    const baseline = replay();
    const variants = [
      replay({ actor: otherActor }),
      replay({
        actor: otherWorkspaceActor,
        routeWorkspaceId: otherWorkspaceId,
      }),
      replay({ runId: '33333333-3333-4333-8333-333333333333' }),
      replay({ workflowVersionId: '44444444-4444-4444-8444-444444444444' }),
      replay({ input: null }),
      replay({ input: { changed: true } }),
      replay({ deadlineAt: '2026-08-21T18:00:00.000Z' }),
    ];
    expect(new Set([baseline, ...variants]).size).toBe(variants.length + 1);
  });
});
