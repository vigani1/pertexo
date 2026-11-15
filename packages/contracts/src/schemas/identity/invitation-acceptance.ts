import { z } from 'zod';
import {
  delegatedWorkspaceRoleSchema,
  workspaceRoleSchema,
} from './membership.js';
import { RESOURCE_NAME_MAX_LENGTH } from '../shared/resource-name.js';
import { workspaceIdentifierSchema } from './workspaces.js';

// The journey an invitation link starts: resolving its token, binding it to
// a session and completing it into a membership.

export const invitationAcceptanceResolveRequestSchema = z
  .object({ token: z.string().min(1).max(1_024) })
  .strict();
export const invitationAcceptanceSessionRequestSchema = z.object({}).strict();
export const invitationAcceptanceCompleteRequestSchema = z
  .object({
    intentId: z.uuid(),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const acceptanceBaseShape = {
  intentId: z.uuid(),
  expiresAt: z.iso.datetime(),
  csrfToken: z.string().min(32).max(512),
} satisfies z.ZodRawShape;
const acceptanceUnavailableSchema = z
  .object({ state: z.literal('unavailable') })
  .strict();
const acceptanceBoundStateSchema = z.discriminatedUnion('state', [
  z
    .object({
      ...acceptanceBaseShape,
      state: z.literal('sign_in_required'),
    })
    .strict(),
  z
    .object({ ...acceptanceBaseShape, state: z.literal('wrong_account') })
    .strict(),
  z.object({ ...acceptanceBaseShape, state: z.literal('expired') }).strict(),
  z.object({ ...acceptanceBaseShape, state: z.literal('revoked') }).strict(),
  z.object({ ...acceptanceBaseShape, state: z.literal('superseded') }).strict(),
  z
    .object({
      ...acceptanceBaseShape,
      state: z.literal('ready'),
      workspace: z
        .object({
          id: workspaceIdentifierSchema,
          name: z.string().min(1).max(RESOURCE_NAME_MAX_LENGTH),
        })
        .strict(),
      role: delegatedWorkspaceRoleSchema,
      invitationRevision: z.number().int().positive(),
      sessionRotationRequired: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...acceptanceBaseShape,
      state: z.literal('completed'),
      workspace: z
        .object({
          id: workspaceIdentifierSchema,
          name: z.string().min(1).max(RESOURCE_NAME_MAX_LENGTH),
        })
        .strict(),
      role: workspaceRoleSchema,
      membershipCreated: z.boolean(),
    })
    .strict(),
]);
export const invitationAcceptanceJourneySchema = z.union([
  acceptanceUnavailableSchema,
  acceptanceBoundStateSchema,
]);
export const invitationAcceptanceReceiptSchema = z
  .object({
    intentId: z.uuid(),
    workspaceId: workspaceIdentifierSchema,
    role: workspaceRoleSchema,
    membershipCreated: z.boolean(),
    replayed: z.boolean(),
  })
  .strict();

export type InvitationAcceptanceJourney = z.output<
  typeof invitationAcceptanceJourneySchema
>;
export type InvitationAcceptanceReceipt = z.output<
  typeof invitationAcceptanceReceiptSchema
>;
