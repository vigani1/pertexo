import { describe, expect, it } from 'vitest';

import {
  InvalidWorkspaceInboxCursorError,
  decodeWorkspaceInboxCursor,
  encodeWorkspaceInboxCursor,
} from '../../src/notifications/cursor.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const position = {
  latestOccurredAt: '2026-09-28T11:00:00.000900Z',
  workflowId: '22222222-2222-4222-8222-222222222222',
};
const context = { workspaceId, filter: 'unread' as const };

describe('workspace inbox cursor', () => {
  it('round-trips an opaque keyset position', () => {
    const cursor = encodeWorkspaceInboxCursor(context, position);
    expect(cursor).not.toContain(position.workflowId);
    expect(decodeWorkspaceInboxCursor(cursor, context)).toEqual(position);
  });

  it.each([
    ['another workspace', { ...context, workspaceId: position.workflowId }],
    ['another filter', { ...context, filter: 'all' as const }],
  ])('refuses a cursor reused for %s', (_case, other) => {
    const cursor = encodeWorkspaceInboxCursor(context, position);
    expect(() => decodeWorkspaceInboxCursor(cursor, other)).toThrow(
      InvalidWorkspaceInboxCursorError,
    );
  });

  it.each([
    'not-a-cursor',
    Buffer.from('{"kind":"workflow-runs"}').toString('base64url'),
    Buffer.from(
      JSON.stringify({
        kind: 'workspace-inbox',
        ...context,
        ...position,
        latestOccurredAt: '2026-09-28T11:00:00Z',
      }),
    ).toString('base64url'),
  ])('refuses a malformed cursor %#', (cursor) => {
    expect(() => decodeWorkspaceInboxCursor(cursor, context)).toThrow(
      InvalidWorkspaceInboxCursorError,
    );
  });
});
