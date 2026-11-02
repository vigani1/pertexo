import type { Pool } from 'pg';

import type {
  CompleteInvitationAcceptanceInput,
  RecordInvitationAcceptanceProofInput,
  ResolveInvitationAcceptanceInput,
} from '../../contract.js';

import { completeAcceptance } from './complete.repository.js';
import { resolveInvitationAcceptance } from './resolve.repository.js';
import {
  readInvitationAcceptance,
  recordInvitationAcceptanceProof,
  abandonInvitationAcceptance,
} from './proof.repository.js';

/**
 * Off withWorkspaceAccess: no member is behind these. An invitation's token is,
 * and whoever holds it isn't a member until acceptance commits.
 */
export function createIdentityWorkspaceInvitationAcceptanceStore(pool: Pool) {
  return Object.freeze({
    resolveInvitationAcceptance: (raw: ResolveInvitationAcceptanceInput) =>
      resolveInvitationAcceptance(pool, raw),

    readInvitationAcceptance: (workspaceId: string, bindingDigest: string) =>
      readInvitationAcceptance(pool, workspaceId, bindingDigest),

    recordInvitationAcceptanceProof: (
      raw: RecordInvitationAcceptanceProofInput,
    ) => recordInvitationAcceptanceProof(pool, raw),

    completeInvitationAcceptance: async (
      raw: CompleteInvitationAcceptanceInput,
    ) => completeAcceptance(pool, raw),

    abandonInvitationAcceptance: (
      workspaceId: string,
      intentId: string,
      bindingDigest: string,
    ) =>
      abandonInvitationAcceptance(pool, workspaceId, intentId, bindingDigest),
  });
}
