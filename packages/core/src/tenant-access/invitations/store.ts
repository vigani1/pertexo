import type { Pool } from 'pg';
import type {
  CreateWorkspaceInvitationInput,
  ListWorkspaceInvitationsInput,
  ResendWorkspaceInvitationInput,
  RevokeWorkspaceInvitationInput,
} from '../contract.js';
import {
  resendInvitation,
  revokeInvitation,
} from './management/commands.repository.js';
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
    resendWorkspaceInvitation: (raw: ResendWorkspaceInvitationInput) =>
      resendInvitation(pool, raw),
    revokeWorkspaceInvitation: (raw: RevokeWorkspaceInvitationInput) =>
      revokeInvitation(pool, raw),
  });
}
