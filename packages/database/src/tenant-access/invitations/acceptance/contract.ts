import { DELEGATED_ROLES } from '@pertexo/workflow-model';

import { z } from 'zod';

import type { IdentityWorkspaceDatabase } from '../../contract.js';

export type AcceptanceStore = Pick<
  IdentityWorkspaceDatabase,
  | 'resolveInvitationAcceptance'
  | 'readInvitationAcceptance'
  | 'recordInvitationAcceptanceProof'
  | 'completeInvitationAcceptance'
  | 'abandonInvitationAcceptance'
>;

export const digest = z.string().regex(/^[0-9a-f]{64}$/u);

export const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u);

export const delegatedRole = z.enum(DELEGATED_ROLES);

export type IntentRow = Readonly<{
  id: string;
  workspace_id: string;
  invitation_id: string;
  invitation_revision: number;
  status: string;
  expires_at: Date;
  verified_user_id: string | null;
  verified_session_id: string | null;
  verified_email: string | null;
  verified_at: Date | null;
  accepted_user_id: string | null;
  receipt: unknown;
  workspace_name: string | null;
  invitation_role: string | null;
  invitation_status: string | null;
}>;

export type ReplacementClaimRow = Readonly<{
  successor_workspace_id: string;
  successor_intent_id: string;
  successor_invitation_id: string;
  successor_invitation_revision: number;
  successor_binding_digest: string;
  successor_csrf_digest: string;
}>;

export type ReplacementIntentRow = Readonly<{
  id: string;
  invitation_id: string;
  invitation_revision: number;
  binding_digest: string;
  csrf_digest: string;
  status: string;
  expires_at: Date;
}>;

export const intentSelection = `intent.id,intent.workspace_id,intent.invitation_id,
  intent.invitation_revision,intent.status,intent.expires_at,
  intent.verified_user_id,intent.verified_session_id,intent.verified_email,intent.verified_at,
  intent.accepted_user_id,intent.receipt,workspace.name workspace_name,
  invitation.role invitation_role,invitation.status invitation_status`;
