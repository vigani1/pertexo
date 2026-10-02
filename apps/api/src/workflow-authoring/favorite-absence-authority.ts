import type { WorkflowFavoriteAbsenceTokenAuthority } from '@pertexo/database/api';
import {
  createWorkflowFavoriteAbsenceTokenCodec,
  InvalidWorkflowFavoriteAbsenceTokenError,
  type WorkflowFavoriteAbsenceTokenCodec,
} from './favorite-absence-token.js';

/** Application-owned cryptography; the repository receives no root key and
 * no transport caller can supply the trusted generation/proof selector. */
export function workflowFavoriteAbsenceAuthority(
  codec: WorkflowFavoriteAbsenceTokenCodec,
): WorkflowFavoriteAbsenceTokenAuthority {
  const authority: WorkflowFavoriteAbsenceTokenAuthority = {
    issue: codec.issue,
    verify(value, scope, generation) {
      try {
        return codec.verify(value, scope, generation);
      } catch (error: unknown) {
        if (error instanceof InvalidWorkflowFavoriteAbsenceTokenError)
          return null;
        throw error;
      }
    },
  };
  return Object.freeze(authority);
}

export function createWorkflowFavoriteAbsenceAuthority(
  key: Uint8Array,
): WorkflowFavoriteAbsenceTokenAuthority {
  return workflowFavoriteAbsenceAuthority(
    createWorkflowFavoriteAbsenceTokenCodec(key),
  );
}
