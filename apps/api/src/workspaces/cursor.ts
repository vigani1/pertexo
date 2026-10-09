import { z } from 'zod';

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
  return Buffer.from(
    JSON.stringify(
      memberCursorPayloadSchema.parse({
        kind: 'workspace_members',
        ...input,
      }),
    ),
    'utf8',
  ).toString('base64url');
}

export function decodeWorkspaceMemberCursor(
  value: string,
): Readonly<{ createdAt: string; userId: string }> {
  try {
    const payload = memberCursorPayloadSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    return Object.freeze({
      createdAt: payload.createdAt,
      userId: payload.userId,
    });
  } catch {
    throw new InvalidWorkspaceMemberCursorError();
  }
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
  return Buffer.from(
    JSON.stringify(
      invitationCursorPayloadSchema.parse({
        kind: 'workspace_invitations',
        ...input,
      }),
    ),
    'utf8',
  ).toString('base64url');
}

export function decodeWorkspaceInvitationCursor(
  value: string,
): Readonly<{ createdAt: string; invitationId: string }> {
  try {
    const payload = invitationCursorPayloadSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    return Object.freeze({
      createdAt: payload.createdAt,
      invitationId: payload.invitationId,
    });
  } catch {
    throw new InvalidWorkspaceInvitationCursorError();
  }
}
