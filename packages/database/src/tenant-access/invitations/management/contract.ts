import { DELEGATED_ROLES } from '@pertexo/workflow-model';

import { z } from 'zod';

import type { IdentityWorkspaceDatabase } from '../../contract.js';

export type InvitationStore = Pick<
  IdentityWorkspaceDatabase,
  | 'listWorkspaceInvitations'
  | 'createWorkspaceInvitation'
  | 'resendWorkspaceInvitation'
  | 'revokeWorkspaceInvitation'
>;

export const delegatedRole = z.enum(DELEGATED_ROLES);

export const revision = z.number().int().positive();

export const idempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u)
  .refine((value) => !value.includes(','));

export const digest = z.string().regex(/^[0-9a-f]{64}$/u);

export const sealedToken = z
  .object({
    ciphertext: z.string().min(1).max(16_384),
    nonce: z.string().min(1).max(128),
    tag: z.string().min(1).max(256),
    keyVersion: z.string().min(1).max(64),
  })
  .strict();

export const durableInvitation = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    email: z.email().max(320),
    role: delegatedRole,
    status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
    revision,
    deliveryStatus: z.enum(['queued', 'submitted', 'failed', 'canceled']),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const durableResult = z
  .object({ invitation: durableInvitation })
  .strict();
