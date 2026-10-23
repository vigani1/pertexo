import { createHttpNodeAttemptProofRuntime } from '../../../../support/attempts/http-node-attempt.runtime.js';
import {
  acceptRun,
  connectionId,
  slackConnectionId,
  withOwner,
  workspaceId,
} from '../../../../support/attempts/http-node-attempt.js';

import { fixtureEncryption, readArtifactIds } from '../../fixture.js';

export async function createArtifactScenario() {
  const encryption = fixtureEncryption;
  if (encryption === undefined)
    throw new Error('HTTP attempt fixture encryption is missing');
  const accepted = await acceptRun();
  const {
    artifactVerifier,
    attemptQueue,
    attempts,
    capabilities,
    coordinator,
    coordinatorQueue,
    emailRequests,
    producer,
    slackRequests,
    telemetry,
    transportRequests,
  } = await createHttpNodeAttemptProofRuntime(encryption, {
    emailResponseScript: [
      { kind: 'rate_limited', retryAfterMillis: 1_000 },
      {
        kind: 'succeeded',
        emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
      },
      { kind: 'invalid_response' },
    ],
  });
  const coordinatorOutboxes = [accepted.outboxEventId];
  const retained: {
    persistedArtifactId: string | undefined;
    artifactBaseline: Set<string> | undefined;
    credentialAuditBaseline: number;
    slackAuditBaseline: number;
  } = {
    persistedArtifactId: undefined,
    artifactBaseline: undefined,
    credentialAuditBaseline: 0,
    slackAuditBaseline: 0,
  };

  return {
    encryption,
    accepted,
    coordinatorOutboxes,
    artifactVerifier,
    attemptQueue,
    attempts,
    capabilities,
    coordinator,
    coordinatorQueue,
    emailRequests,
    producer,
    slackRequests,
    telemetry,
    transportRequests,
    retained,
  };
}

export type ArtifactScenario = Awaited<
  ReturnType<typeof createArtifactScenario>
>;

export async function captureArtifactScenarioBaselines(
  scenario: ArtifactScenario,
) {
  const { retained } = scenario;
  retained.artifactBaseline = await readArtifactIds();
  retained.credentialAuditBaseline = Number(
    (
      await withOwner((client) =>
        client.query<{ count: string }>(
          `select count(*)::text count from app.connection_events
                where workspace_id=$1 and connection_id=$2
                  and event_type='connection.credential_accessed'
                  and actor_kind='worker'`,
          [workspaceId, connectionId],
        ),
      )
    ).rows[0]?.count ?? '0',
  );
  retained.slackAuditBaseline = Number(
    (
      await withOwner((client) =>
        client.query<{ count: string }>(
          `select count(*)::text count from app.connection_events
                where workspace_id=$1 and connection_id=$2
                  and event_type='connection.credential_accessed'
                  and actor_kind='worker'`,
          [workspaceId, slackConnectionId],
        ),
      )
    ).rows[0]?.count ?? '0',
  );
}

export async function closeArtifactScenario(scenario: ArtifactScenario) {
  const {
    artifactVerifier,
    attemptQueue,
    attempts,
    capabilities,
    coordinator,
    coordinatorQueue,
    producer,
    retained,
  } = scenario;
  const errors: unknown[] = [];
  const attempt = async (operation: () => unknown): Promise<void> => {
    await Promise.resolve()
      .then(operation)
      .catch((error: unknown) => errors.push(error));
  };
  await attempt(() => attempts.close());
  await attempt(() => coordinator.close());
  await attempt(() => producer.close());
  await attempt(() => attemptQueue.close());
  await attempt(() => coordinatorQueue.close());
  const baseline = retained.artifactBaseline;
  if (baseline !== undefined)
    await attempt(async () => {
      const current = await readArtifactIds();
      for (const artifactId of current)
        if (!baseline.has(artifactId))
          await artifactVerifier.delete({ artifactId, workspaceId });
    });
  else if (retained.persistedArtifactId !== undefined) {
    const ownedArtifactId = retained.persistedArtifactId;
    await attempt(() =>
      artifactVerifier.delete({
        artifactId: ownedArtifactId,
        workspaceId,
      }),
    );
  }
  await attempt(() => capabilities.close());
  await attempt(() => {
    artifactVerifier.close();
  });
  if (errors.length > 0)
    throw new AggregateError(errors, 'HTTP artifact scenario cleanup failed');
}
