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
