import { z } from 'zod';

import {
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from '../platform/http/opaque-cursor.js';

const memberCursorPayloadSchema = z
  .object({
    kind: z.literal('workspace_members'),
    createdAt: z.iso
      .datetime({ precision: 6 })
      .refine((value) => !value.startsWith('0000-'), {
        message: 'PostgreSQL timestamps do not support year zero',
      }),
    userId: z.uuid(),
  })
  .strict();
const invitationCursorPayloadSchema = z
  .object({
    kind: z.literal('workspace_invitations'),
    createdAt: z.iso
      .datetime({ precision: 6 })
      .refine((value) => !value.startsWith('0000-')),
    invitationId: z.uuid(),
  })
  .strict();

export class InvalidWorkspaceMemberCursorError extends TypeError {
  public override readonly name = 'InvalidWorkspaceMemberCursorError';

  public constructor() {
    super('workspace member cursor is invalid');
  }
}

export function encodeWorkspaceMemberCursor(
  input: Readonly<{
    createdAt: string;
    userId: string;
  }>,
): string {
  return encodeOpaqueCursor(memberCursorPayloadSchema, {
    kind: 'workspace_members',
    ...input,
  });
}

export function decodeWorkspaceMemberCursor(
  value: string,
): Readonly<{ createdAt: string; userId: string }> {
  const payload = decodeOpaqueCursor(memberCursorPayloadSchema, value);
  if (payload === undefined) throw new InvalidWorkspaceMemberCursorError();
  return Object.freeze({
    createdAt: payload.createdAt,
    userId: payload.userId,
  });
}

class InvalidWorkspaceInvitationCursorError extends TypeError {
  public override readonly name = 'InvalidWorkspaceInvitationCursorError';

  public constructor() {
    super('workspace invitation cursor is invalid');
  }
}

export function encodeWorkspaceInvitationCursor(
  input: Readonly<{ createdAt: string; invitationId: string }>,
): string {
  return encodeOpaqueCursor(invitationCursorPayloadSchema, {
    kind: 'workspace_invitations',
    ...input,
  });
}

export function decodeWorkspaceInvitationCursor(
  value: string,
): Readonly<{ createdAt: string; invitationId: string }> {
  const payload = decodeOpaqueCursor(invitationCursorPayloadSchema, value);
  if (payload === undefined) throw new InvalidWorkspaceInvitationCursorError();
  return Object.freeze({
    createdAt: payload.createdAt,
    invitationId: payload.invitationId,
  });
}
