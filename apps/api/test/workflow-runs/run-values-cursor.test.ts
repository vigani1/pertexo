import { it, expect } from 'vitest';
import {
  encodeWorkflowRunCursor,
  decodeWorkflowRunCursor,
} from '../../src/workflow-runs/cursor.js';
const context = { workspaceId: '11111111-1111-4111-8111-111111111111' };
const position = {
  createdAt: '2026-10-21T00:00:00.000123Z',
  id: '22222222-2222-4222-8222-222222222222',
};
it('binds a cursor to exact business values without embedding their text or exceeding the cursor limit', () => {
  const filters = {
    ...context,
    workflowId: '33333333-3333-4333-8333-333333333333',
    workflowNamePrefix: '界'.repeat(128),
    status: 'failed' as const,
    createdAtFrom: '2026-10-01T00:00:00.000000Z',
    createdAtBefore: '2026-10-22T00:00:00.000000Z',
    runValueKey: 'k'.repeat(50),
    runValue: '€'.repeat(255),
  };
  const cursor = encodeWorkflowRunCursor(filters, position);
  expect(cursor.length).toBeLessThanOrEqual(1024);
  expect(Buffer.from(cursor, 'base64url').toString('utf8')).not.toContain(
    filters.runValue,
  );
  expect(decodeWorkflowRunCursor(cursor, filters)).toEqual(position);
  expect(() =>
    decodeWorkflowRunCursor(cursor, { ...filters, runValue: 'other' }),
  ).toThrow();
  expect(() => decodeWorkflowRunCursor(cursor, context)).toThrow();
  expect(() =>
    decodeWorkflowRunCursor(cursor, {
      ...filters,
      workflowNamePrefix: 'Other',
    }),
  ).toThrow();
  expect(() =>
    decodeWorkflowRunCursor(cursor, { ...filters, status: 'succeeded' }),
  ).toThrow();
  expect(() =>
    decodeWorkflowRunCursor(cursor, { ...filters, runValueKey: 'other' }),
  ).toThrow();
});
it('preserves unfiltered cursors but cannot reuse one for an empty-text value filter', () => {
  const cursor = encodeWorkflowRunCursor(context, position);
  expect(decodeWorkflowRunCursor(cursor, context)).toEqual(position);
  expect(() =>
    decodeWorkflowRunCursor(cursor, {
      ...context,
      runValueKey: 'empty',
      runValue: '',
    }),
  ).toThrow();
});
