import type { Pool } from 'pg';
import type {
  ChangeWorkspaceInvitationInput,
  CreateWorkspaceInvitationInput,
  ListWorkspaceInvitationsInput,
} from '../contract.js';
import { changeInvitation } from './management/commands.repository.js';
import { listWorkspaceInvitations } from './management/list.queries.js';
import { createWorkspaceInvitation } from './management/create.repository.js';

export function createIdentityWorkspaceInvitationStore(pool: Pool) {
  return Object.freeze({
    listWorkspaceInvitations: (
      workspaceId: string,
      actorId: string,
      input?: ListWorkspaceInvitationsInput,
    ) => listWorkspaceInvitations(pool, workspaceId, actorId, input),
    createWorkspaceInvitation: (raw: CreateWorkspaceInvitationInput) =>
      createWorkspaceInvitation(pool, raw),
    resendWorkspaceInvitation: (raw: ChangeWorkspaceInvitationInput) =>
      changeInvitation(pool, raw, 'resend'),
    revokeWorkspaceInvitation: (raw: ChangeWorkspaceInvitationInput) =>
      changeInvitation(pool, raw, 'revoke'),
  });
}
