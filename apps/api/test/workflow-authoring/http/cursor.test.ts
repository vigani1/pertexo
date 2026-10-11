import { describe, expect, it } from 'vitest';
import {
  decodeWorkflowCursor,
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
