import { z } from 'zod';

const stamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const revision = z.number().int().positive();

export const renameReceipt = z.object({
  changed: z.boolean(),
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    status: z.string(),
    revision,
    createdBy: z.string(),
    createdAt: stamp,
    updatedAt: stamp,
  }),
});

export const invitationReceipt = z.object({
  invitation: z.object({
    id: z.string(),
    workspaceId: z.string(),
    email: z.string(),
    role: z.string(),
    status: z.string(),
    revision,
    deliveryStatus: z.string(),
    expiresAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
  }),
});

export const tokenReceipt = z.object({ tokenId: z.uuid() });

export const memberReceipt = z.object({
  userId: z.string(),
  roleRevision: revision,
});

export const roleReceipt = memberReceipt.extend({
  role: z.string(),
  changed: z.boolean(),
});

export const memberStatusReceipt = memberReceipt.extend({
  membershipStatus: z.string(),
});

export const ownershipReceipt = z.object({
  ownerUserId: z.string(),
  ownerRoleRevision: revision,
  previousOwnerUserId: z.string(),
  previousOwnerRoleRevision: revision,
});
