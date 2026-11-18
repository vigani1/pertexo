import { describe, expect, it } from 'vitest';
import {
  decodeVersionCursor,
  decodeWorkflowCursor,
  encodeVersionCursor,
  encodeWorkflowCursor,
  InvalidWorkflowCursorError,
} from '../../../src/workflow-authoring/cursor.js';
const child = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const position = {
  positionAt: '2026-10-11T00:00:00.000Z',
  id: '33333333-3333-4333-8333-333333333333',
};
describe('published-parent pagination scope', () => {
  it.each(['created_asc', 'updated_desc'] as const)(
    'binds the %s cursor to its exact pinned child',
    (order) => {
      const value = encodeWorkflowCursor(position, order, child);
      expect(decodeWorkflowCursor(value, order, child)).toEqual(position);
      expect(() => decodeWorkflowCursor(value, order, other)).toThrow(
        InvalidWorkflowCursorError,
      );
      expect(() => decodeWorkflowCursor(value, order)).toThrow(
        InvalidWorkflowCursorError,
      );
      expect(() =>
        decodeWorkflowCursor(
          encodeWorkflowCursor(position, order),
          order,
          child,
        ),
      ).toThrow(InvalidWorkflowCursorError);
    },
  );
});

const workflowId = '44444444-4444-4444-8444-444444444444';
const encoded = (payload: object) =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

describe('workflow and version cursors', () => {
  it('round-trips each order and keeps the two orders apart', () => {
    const created = encodeWorkflowCursor(position);
    expect(decodeWorkflowCursor(created)).toEqual(position);
    const updated = encodeWorkflowCursor(
      { ...position, positionAt: '2026-08-21T12:00:00.000900Z' },
      'updated_desc',
    );
    expect(decodeWorkflowCursor(updated, 'updated_desc')).toEqual({
      ...position,
      positionAt: '2026-08-21T12:00:00.000900Z',
    });
    expect(() => decodeWorkflowCursor(updated)).toThrow(
      InvalidWorkflowCursorError,
    );
    expect(() => decodeWorkflowCursor(created, 'updated_desc')).toThrow(
      InvalidWorkflowCursorError,
    );
  });

  it('round-trips a version cursor and keeps it apart from workflow cursors', () => {
    expect(decodeVersionCursor(encodeVersionCursor(2))).toBe(2);
    expect(() => decodeWorkflowCursor(encodeVersionCursor(2))).toThrow(
      InvalidWorkflowCursorError,
    );
    expect(() => decodeVersionCursor(encodeWorkflowCursor(position))).toThrow(
      InvalidWorkflowCursorError,
    );
  });

  it.each([
    { name: 'empty input', cursor: '' },
    {
      name: 'malformed decoded JSON',
      cursor: Buffer.from('{', 'utf8').toString('base64url'),
    },
    {
      name: 'an unknown field',
      cursor: encoded({
        kind: 'workflow',
        createdAt: '2026-08-20T12:00:00.000Z',
        id: workflowId,
        unknown: true,
      }),
    },
    {
      name: 'an absent date',
      cursor: encoded({ kind: 'workflow', id: workflowId }),
    },
    {
      name: 'an invalid date',
      cursor: encoded({
        kind: 'workflow',
        createdAt: 'not-a-date',
        id: workflowId,
      }),
    },
    {
      name: 'an invalid workflow ID',
      cursor: encoded({
        kind: 'workflow',
        createdAt: '2026-08-20T12:00:00.000Z',
        id: 'not-a-uuid',
      }),
    },
  ])('refuses a workflow cursor with $name', ({ cursor }) => {
    expect(() => decodeWorkflowCursor(cursor)).toThrow(
      InvalidWorkflowCursorError,
    );
  });

  it.each([
    { name: 'an absent version', cursor: encoded({ kind: 'versions' }) },
    {
      name: 'a zero version',
      cursor: encoded({ kind: 'versions', beforeVersionNumber: 0 }),
    },
    {
      name: 'a fractional version',
      cursor: encoded({ kind: 'versions', beforeVersionNumber: 1.5 }),
    },
    {
      name: 'an unknown field',
      cursor: encoded({
        kind: 'versions',
        beforeVersionNumber: 2,
        unknown: true,
      }),
    },
  ])('refuses a version cursor with $name', ({ cursor }) => {
    expect(() => decodeVersionCursor(cursor)).toThrow(
      InvalidWorkflowCursorError,
    );
  });
});
