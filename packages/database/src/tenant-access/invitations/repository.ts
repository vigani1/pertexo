import type { Pool } from 'pg';
import type { InvitationStore } from './management/contract.js';
import { changeInvitation } from './management/commands.repository.js';
import { listWorkspaceInvitations } from './management/list.queries.js';
import { createWorkspaceInvitation } from './management/create.repository.js';

export function createIdentityWorkspaceInvitationStore(
  pool: Pool,
): InvitationStore {
  return Object.freeze({
    listWorkspaceInvitations: (workspaceId, actorId, input = {}) =>
      listWorkspaceInvitations(pool, workspaceId, actorId, input),
    createWorkspaceInvitation: (raw) => createWorkspaceInvitation(pool, raw),
    resendWorkspaceInvitation: (raw) => changeInvitation(pool, raw, 'resend'),
    revokeWorkspaceInvitation: (raw) => changeInvitation(pool, raw, 'revoke'),
  });
}
