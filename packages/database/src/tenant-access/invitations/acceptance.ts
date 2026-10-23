import type { Pool } from 'pg';

import type {
  CompleteInvitationAcceptanceInput,
  ResolveInvitationAcceptanceInput,
} from '../contracts.js';

import type { AcceptanceStore } from './acceptance/contract.js';

import { completeAcceptance } from './acceptance/complete.js';
import { resolveInvitationAcceptance } from './acceptance/resolve.js';
import {
  readInvitationAcceptance,
  recordInvitationAcceptanceProof,
  abandonInvitationAcceptance,
} from './acceptance/proof.js';

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
