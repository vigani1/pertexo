import type { WorkspaceInboxFilter } from '@pertexo/contracts';
import { z } from 'zod';

import {
  opaqueCursor,
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from '../platform/http/opaque-cursor.js';

const cursorPayloadSchema = opaqueCursor('workspace-inbox', {
  workspaceId: z.uuid(),
  filter: z.enum(['all', 'unread']),
  noticeKind: z.string().optional(),
  latestOccurredAt: z.iso.datetime({ precision: 6 }),
  threadId: z.uuid(),
});

export type WorkspaceInboxPosition = Readonly<{
  latestOccurredAt: string;
  threadId: string;
}>;

export class InvalidWorkspaceInboxCursorError extends TypeError {
  public override readonly name = 'InvalidWorkspaceInboxCursorError';

  public constructor() {
    super('workspace inbox cursor is invalid');
  }
}

/** An opaque keyset position, valid only for its workspace and filter. */
export function encodeWorkspaceInboxCursor(
  context: Readonly<{
    workspaceId: string;
    filter: WorkspaceInboxFilter;
    noticeKind?: string;
  }>,
  position: WorkspaceInboxPosition,
): string {
  return encodeOpaqueCursor(cursorPayloadSchema, {
    kind: 'workspace-inbox',
    workspaceId: context.workspaceId,
    filter: context.filter,
    ...(context.noticeKind === undefined
      ? {}
      : { noticeKind: context.noticeKind }),
    ...position,
  });
}

export function decodeWorkspaceInboxCursor(
  value: string,
  context: Readonly<{
    workspaceId: string;
    filter: WorkspaceInboxFilter;
    noticeKind?: string;
  }>,
): WorkspaceInboxPosition {
  const payload = decodeOpaqueCursor(cursorPayloadSchema, value);
  if (
    payload?.workspaceId !== context.workspaceId ||
    payload.filter !== context.filter ||
    payload.noticeKind !== context.noticeKind
  )
    throw new InvalidWorkspaceInboxCursorError();
  return Object.freeze({
    latestOccurredAt: payload.latestOccurredAt,
    threadId: payload.threadId,
  });
}
