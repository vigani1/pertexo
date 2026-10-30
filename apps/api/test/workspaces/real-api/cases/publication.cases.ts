import { workflowSummaryResponseSchema } from '@pertexo/contracts';
import { expect, it } from 'vitest';

import type { createWorkspaceApiFixture } from '../fixture.js';

export function registerAuthorsPublishesWorkflowThroughRealAuthRLS(
  caseFixture: ReturnType<typeof createWorkspaceApiFixture>,
): void {
  const { login, createPublishedWorkflow } = caseFixture;

  it('authors and publishes a workflow through real auth, RLS, and ETags', async () => {
    const cookies = await login();
    const { base, createdBody, publishedBody } =
      await createPublishedWorkflow(cookies);

    const read = await caseFixture.application.inject({
      method: 'GET',
      url: `${base}/${createdBody.workflow.id}`,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(read.statusCode).toBe(200);
    expect(
      workflowSummaryResponseSchema.parse(read.json()).workflow
        .publishedVersionId,
    ).toBe(publishedBody.version.id);
  });
}
