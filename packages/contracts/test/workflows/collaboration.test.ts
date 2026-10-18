import { expect, it } from 'vitest';
import {
  workflowCommentBodySchema,
  workflowCommentCreateSchema,
  workflowCommentListQuerySchema,
  workflowPresenceHeartbeatSchema,
  workflowCommentDetailQuerySchema,
} from '../../src/index.js';
const member = '11111111-1111-4111-8111-111111111111';
it('bounds plain Unicode comments and explicit mentions at their single boundary', () => {
  expect(workflowCommentCreateSchema.parse({ body: ' 🧵 Review ' })).toEqual({
    body: '🧵 Review',
    mentionUserIds: [],
    stepId: null,
  });
  for (const body of ['', 'x'.repeat(8001), 'nul\u0000', 'broken\ud800'])
    expect(workflowCommentBodySchema.safeParse({ body }).success).toBe(false);
  expect(
    workflowCommentBodySchema.safeParse({
      body: 'Review',
      mentionUserIds: [member, member],
    }).success,
  ).toBe(false);
  expect(
    workflowCommentBodySchema.safeParse({ body: 'Review', html: '<b>no</b>' })
      .success,
  ).toBe(false);
  expect(
    workflowCommentBodySchema.safeParse({
      body: 'Review',
      mentionUserIds: Array.from(
        { length: 21 },
        (_, index) =>
          `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
      ),
    }).success,
  ).toBe(false);
});
it('requires consistent scope/cursors and bounded monotonic presence metadata', () => {
  expect(
    workflowCommentListQuerySchema.safeParse({ scope: 'step' }).success,
  ).toBe(false);
  expect(
    workflowCommentListQuerySchema.safeParse({ scope: 'all', stepId: 'a' })
      .success,
  ).toBe(false);
  expect(workflowCommentListQuerySchema.safeParse({ limit: 21 }).success).toBe(
    false,
  );
  expect(
    workflowCommentDetailQuerySchema.safeParse({
      anchor: member,
      before: member,
    }).success,
  ).toBe(false);
  const heartbeat = {
    sequence: 1,
    editing: true,
    dirty: true,
    baseRevision: 1,
  };
  expect(workflowPresenceHeartbeatSchema.parse(heartbeat)).toEqual(heartbeat);
  for (const overrides of [
    { sequence: 0 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { editing: false },
    { baseRevision: null },
    { graph: {} },
  ])
    expect(
      workflowPresenceHeartbeatSchema.safeParse({ ...heartbeat, ...overrides })
        .success,
    ).toBe(false);
});
