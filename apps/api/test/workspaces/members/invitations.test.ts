import { describe, expect, it } from 'vitest';
import { toProblem } from '../../../src/problems/api-problem-registry.js';
import { workspaceFailure } from '../../../src/problems/context/normalize-context-errors.js';
import {
  WorkspaceInvitationCommandConflictError,
  InvitationAcceptanceConflictError,
} from '@pertexo/core/tenant-access';

/**
 * Creating, resolving, rebinding, proving and completing an invitation run on
 * the real Better Auth API in better-auth/real-api.integration.test.ts. These
 * two refusals come from core states no request produces on demand.
 */
describe('workspace invitation problems', () => {
  it('maps unresolved delivery to a truthful recoverable problem', () => {
    expect(
      toProblem(
        workspaceFailure(
          new WorkspaceInvitationCommandConflictError(
            'delivery_unresolved',
            'Email delivery could not be confirmed. Revoke this invitation and create a new one to send another link.',
          ),
        ),
      ),
    ).toMatchObject({
      code: 'workspace.invitation_delivery_unavailable',
      safeDetail:
        'Email delivery could not be confirmed. Revoke this invitation and create a new one to send another link.',
    });
  });

  it('maps expired recipient proof separately from other invitation conflicts', () => {
    expect(
      toProblem(
        workspaceFailure(
          new InvitationAcceptanceConflictError(
            'proof_expired',
            'Fresh recipient verification is required',
          ),
        ),
      ),
    ).toMatchObject({
      code: 'workspace.invitation_proof_expired',
      safeDetail: 'Verify the invited account again before accepting.',
    });
  });
});
