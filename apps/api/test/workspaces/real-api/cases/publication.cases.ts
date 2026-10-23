import { it } from 'vitest';

import type { createWorkspaceApiFixture } from '../fixture.js';

export function registerAuthorsPublishesWorkflowThroughRealAuthRLS(
  caseFixture: ReturnType<typeof createWorkspaceApiFixture>,
): void {
  const { login, createPublishedWorkflow } = caseFixture;

  it('authors and publishes a workflow through real auth, RLS, and ETags', async () => {
    const cookies = await login();
    await createPublishedWorkflow(cookies);
  });
}
