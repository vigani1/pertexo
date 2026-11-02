import type { Pool } from 'pg';

import type {
  CompleteInvitationAcceptanceInput,
  ResolveInvitationAcceptanceInput,
} from '../../contract.js';

import type { AcceptanceStore } from './contract.js';

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
export function createIdentityWorkspaceInvitationAcceptanceStore(
  pool: Pool,
): AcceptanceStore {
  return Object.freeze({
    resolveInvitationAcceptance: (raw: ResolveInvitationAcceptanceInput) =>
      resolveInvitationAcceptance(pool, raw),

    readInvitationAcceptance: (workspaceIdInput, bindingDigestInput) =>
      readInvitationAcceptance(pool, workspaceIdInput, bindingDigestInput),

    recordInvitationAcceptanceProof: (raw) =>
      recordInvitationAcceptanceProof(pool, raw),

    completeInvitationAcceptance: async (
      raw: CompleteInvitationAcceptanceInput,
    ) => completeAcceptance(pool, raw),

    abandonInvitationAcceptance: (
      workspaceIdInput,
      intentIdInput,
      bindingDigestInput,
    ) =>
      abandonInvitationAcceptance(
        pool,
        workspaceIdInput,
        intentIdInput,
        bindingDigestInput,
      ),
  });
}
