import type { WorkspaceInboxFilter } from '@pertexo/contracts';
import { z } from 'zod';

import {
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from '../platform/http/opaque-cursor.js';

const cursorPayloadSchema = z
  .object({
    kind: z.literal('workspace-inbox'),
    workspaceId: z.uuid(),
    filter: z.enum(['all', 'unread']),
    latestOccurredAt: z.iso.datetime({ precision: 6 }),
    workflowId: z.uuid(),
  })
  .strict();

export type WorkspaceInboxPosition = Readonly<{
  latestOccurredAt: string;
  workflowId: string;
}>;

export class InvalidWorkspaceInboxCursorError extends TypeError {
  public override readonly name = 'InvalidWorkspaceInboxCursorError';

  public constructor() {
    super('workspace inbox cursor is invalid');
  }
}

/** An opaque keyset position, valid only for its workspace and filter. */
export function encodeWorkspaceInboxCursor(
  context: Readonly<{ workspaceId: string; filter: WorkspaceInboxFilter }>,
  position: WorkspaceInboxPosition,
): string {
  return encodeOpaqueCursor(cursorPayloadSchema, {
    kind: 'workspace-inbox',
    workspaceId: context.workspaceId,
    filter: context.filter,
    ...position,
  });
}

export function decodeWorkspaceInboxCursor(
  value: string,
  context: Readonly<{ workspaceId: string; filter: WorkspaceInboxFilter }>,
): WorkspaceInboxPosition {
  const payload = decodeOpaqueCursor(cursorPayloadSchema, value);
  if (
    payload?.workspaceId !== context.workspaceId ||
    payload.filter !== context.filter
  )
    throw new InvalidWorkspaceInboxCursorError();
  return Object.freeze({
    latestOccurredAt: payload.latestOccurredAt,
    workflowId: payload.workflowId,
  });
}
