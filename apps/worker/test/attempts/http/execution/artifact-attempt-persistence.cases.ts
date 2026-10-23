import { it } from 'vitest';

import { runWithCleanup } from '../../../support/infrastructure/test-operation.js';

import {
  createArtifactScenario,
  captureArtifactScenarioBaselines,
  closeArtifactScenario,
} from './artifact-scenario/context.js';
import {
  executeArtifactHttpAttempt,
  assertArtifactHttpEvidence,
  proveArtifactHttpRedelivery,
} from './artifact-scenario/http.js';
import { proveArtifactSlackRedelivery } from './artifact-scenario/slack.js';
import { proveArtifactEmailRetry } from './artifact-scenario/email.js';
import { proveArtifactRotatedCredentialFence } from './artifact-scenario/rotation.js';
import { assertArtifactScenarioPrivacy } from './artifact-scenario/privacy.js';

export function registerArtifactAttemptPersistence(): void {
  it('commits artifact, attempt truth, audit, bounded telemetry, and inert exact redelivery without leaking credentials', async () => {
    const scenario = await createArtifactScenario();
    await runWithCleanup(
      async () => {
        await captureArtifactScenarioBaselines(scenario);
        const http = await executeArtifactHttpAttempt(scenario);
        const audit = await assertArtifactHttpEvidence(scenario, http);
        const replay = await proveArtifactHttpRedelivery(scenario, {
          ...http,
          audit,
        });
        const slack = await proveArtifactSlackRedelivery(scenario);
        const email = await proveArtifactEmailRetry(scenario);
        await proveArtifactRotatedCredentialFence(scenario);
        await assertArtifactScenarioPrivacy(scenario, {
          delivery: http.delivery,
          replay,
          ...slack,
          ...email,
        });
      },
      () => closeArtifactScenario(scenario),
      'HTTP artifact scenario',
    );
  }, 30_000);
}
