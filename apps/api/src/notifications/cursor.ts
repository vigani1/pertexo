import type { WorkspaceInboxFilter } from '@pertexo/contracts';
import { z } from 'zod';

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
  return Buffer.from(
    JSON.stringify(
      cursorPayloadSchema.parse({
        kind: 'workspace-inbox',
        workspaceId: context.workspaceId,
        filter: context.filter,
        ...position,
      }),
    ),
    'utf8',
  ).toString('base64url');
}

export function decodeWorkspaceInboxCursor(
  value: string,
  context: Readonly<{ workspaceId: string; filter: WorkspaceInboxFilter }>,
): WorkspaceInboxPosition {
  let payload: z.output<typeof cursorPayloadSchema>;
  try {
    payload = cursorPayloadSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
  } catch {
    throw new InvalidWorkspaceInboxCursorError();
  }
  if (
    payload.workspaceId !== context.workspaceId ||
    payload.filter !== context.filter
  )
    throw new InvalidWorkspaceInboxCursorError();
  return Object.freeze({
    latestOccurredAt: payload.latestOccurredAt,
    workflowId: payload.workflowId,
  });
}
