import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  actorId,
  authoring,
  identity,
  saveCurrentDraft,
  workspaceId,
} from '../support/workflow-authoring.js';
import {
  admin,
  afterAllFixture2,
  beforeAllFixture1,
  builder,
  request,
  reviews,
} from './publication-review/fixture.js';

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);

/** Postgres ends one side of a deadlock with 40P01, however the flow words it. */
function deadlocked(result: PromiseSettledResult<unknown>) {
  if (result.status === 'fulfilled') return false;
  for (let error: unknown = result.reason; error instanceof Object;) {
    if ('code' in error && error.code === '40P01') return true;
    error = 'cause' in error ? error.cause : undefined;
  }
  return false;
}

it('asking for a review holds against decisions, reads, draft saves and a rename', async () => {
  const seeded = await Promise.all(
    Array.from({ length: 6 }).map(() => request()),
  );
  const results = await Promise.allSettled(
    seeded.flatMap(({ command, review }, turn) => [
      // The same workflow again, new key: refused or answered, never deadlocked.
      reviews().request({ ...command, idempotencyKey: randomUUID() }),
      request(),
      reviews().decide({
        workspaceId,
        actorId: admin,
        reviewId: review.id,
        decision: turn % 2 === 0 ? 'approve' : 'reject',
        idempotencyKey: randomUUID(),
      }),
      reviews().overview({
        workspaceId,
        actorId: builder,
        workflowId: command.workflowId,
      }),
      reviews().read({ workspaceId, actorId: admin, reviewId: review.id }),
      saveCurrentDraft(authoring, {
        workspaceId,
        actorId: builder,
        workflowId: command.workflowId,
        expectedRevision: 1,
        graphJson: { nodes: [], edges: [], settings: {} },
      }),
      identity.renameWorkspace({
        workspaceId,
        actorUserId: actorId,
        name: `Renamed ${String(turn)}`,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ]),
  );
  expect(results.filter(deadlocked)).toEqual([]);
  // Some must really have landed, or the burst proved nothing.
  expect(
    results.filter((result) => result.status === 'fulfilled').length,
  ).toBeGreaterThan(seeded.length);
}, 60_000);
