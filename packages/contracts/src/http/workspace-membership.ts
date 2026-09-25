import { z } from 'zod';

/*
 * ADR 047 membership lifecycle: leaving a workspace, suspending and
 * reactivating a member, and transferring ownership. Each command is fenced
 * by the membership role revisions it depends on and returns a small receipt
 * of the accepted command, not necessarily the latest state on replay.
 */

const roleRevisionSchema = z.number().int().positive();

/** Leaving depends on no revision; the owner check runs under lock. */
export const workspaceLeaveRequestSchema = z.object({}).strict();
export const workspaceLeaveResponseSchema = z
  .object({
    userId: z.uuid(),
    roleRevision: roleRevisionSchema,
    replayed: z.boolean(),
  })
  .strict();
export const workspaceMemberStatusRequestSchema = z
  .object({ expectedRoleRevision: roleRevisionSchema })
  .strict();
export const workspaceMemberStatusResponseSchema = z
  .object({
    userId: z.uuid(),
    roleRevision: roleRevisionSchema,
    membershipStatus: z.enum(['active', 'suspended']),
    replayed: z.boolean(),
  })
  .strict();
/** Both memberships change, so both revisions fence the transfer. */
export const workspaceOwnershipTransferRequestSchema = z
  .object({
    expectedRoleRevision: roleRevisionSchema,
    expectedOwnerRoleRevision: roleRevisionSchema,
  })
  .strict();
export const workspaceOwnershipTransferResponseSchema = z
  .object({
    ownerUserId: z.uuid(),
    ownerRoleRevision: roleRevisionSchema,
    previousOwnerUserId: z.uuid(),
    previousOwnerRoleRevision: roleRevisionSchema,
    replayed: z.boolean(),
  })
  .strict();

export type WorkspaceLeaveResponse = z.output<
  typeof workspaceLeaveResponseSchema
>;
export type WorkspaceMemberStatusRequest = z.input<
  typeof workspaceMemberStatusRequestSchema
>;
export type WorkspaceMemberStatusResponse = z.output<
  typeof workspaceMemberStatusResponseSchema
>;
export type WorkspaceOwnershipTransferRequest = z.input<
  typeof workspaceOwnershipTransferRequestSchema
>;
export type WorkspaceOwnershipTransferResponse = z.output<
  typeof workspaceOwnershipTransferResponseSchema
>;
