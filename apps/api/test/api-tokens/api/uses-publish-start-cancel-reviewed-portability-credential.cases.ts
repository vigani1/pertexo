import { it } from 'vitest';

import type { createAutomationApiFixture } from './fixture.js';
import { createTokenWorkspace } from './portability/setup.js';
import { qualifyCredentialRuns } from './portability/runs.js';
import { qualifyReviewedPortability } from './portability/manifest.js';
import { qualifyRoleRevocation } from './portability/revocation.js';

export function registerUsesPublishStartCancelReviewedPortabilityCredential(
  caseFixture: ReturnType<typeof createAutomationApiFixture>,
): void {
  it('uses publish, start, cancel and reviewed portability with credential-isolated receipts', async () => {
    const workspace = await createTokenWorkspace(caseFixture);
    const execution = await qualifyCredentialRuns(caseFixture, workspace);
    const portability = await qualifyReviewedPortability(
      caseFixture,
      workspace,
    );
    await qualifyRoleRevocation(caseFixture, {
      ...workspace,
      ...execution,
      ...portability,
    });
  });
}
