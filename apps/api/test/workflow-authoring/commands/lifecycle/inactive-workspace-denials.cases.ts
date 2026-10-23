import { it } from 'vitest';

import { expectProblem, mutationHeaders } from '../../lifecycle.support.js';
import { lifecyclePath, fixture } from './fixture.js';

export function registerInactiveWorkspaceDenials(): void {
  for (const status of ['suspended', 'pending_deletion'] as const) {
    it(`hides lifecycle commands while the workspace is ${status}`, async () => {
      const { application, ids, workspaceId } = fixture;
      await fixture.setWorkspaceStatus(status);
      try {
        const owner = await fixture.login('owner');
        for (const command of ['archive', 'restore'] as const) {
          const denied = await application.inject({
            method: 'POST',
            url: lifecyclePath(workspaceId, ids.unpublished, command),
            headers: mutationHeaders(owner),
            payload: { expectedLifecycleRevision: 1 },
          });
          expectProblem(denied, 404, 'resource.not_found');
        }
      } finally {
        await fixture.setWorkspaceStatus('active');
      }
    });
  }
}
