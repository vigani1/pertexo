import { expect } from 'vitest';

import {
  emailRecipient,
  emailSubject,
  emailText,
  plaintextSecret,
  resendApiKey,
  rotatedResendApiKey,
  slackBotToken,
  slackMessageText,
  withOwner,
  workspaceId,
} from '../../../../support/attempts/http-node-attempt.js';

import type { ArtifactScenario } from './context.js';
import type { proveArtifactHttpRedelivery } from './http.js';
import type { HttpEvidence } from './http.js';
import type { proveArtifactSlackRedelivery } from './slack.js';
import type { proveArtifactEmailRetry } from './email.js';

type PrivateEvidence = Pick<HttpEvidence, 'delivery'> & {
  replay: Awaited<ReturnType<typeof proveArtifactHttpRedelivery>>;
} & Awaited<ReturnType<typeof proveArtifactSlackRedelivery>> &
  Awaited<ReturnType<typeof proveArtifactEmailRetry>>;

export async function assertArtifactScenarioPrivacy(
  scenario: ArtifactScenario,
  evidence: PrivateEvidence,
) {
  const { telemetry } = scenario;
  const {
    delivery,
    replay,
    slackDelivery,
    replayedSlackJob,
    emailDelivery,
    replayedEmailJob,
  } = evidence;
  const durableSurface = await withOwner((client) =>
    client.query<{ surface: string }>(
      `select concat_ws(E'\n',
             (select jsonb_agg(to_jsonb(secret))::text
                from app.connection_secret_versions secret where workspace_id=$1),
             (select jsonb_agg(to_jsonb(event))::text
                from app.connection_events event where workspace_id=$1),
             (select jsonb_agg(to_jsonb(attempt))::text
                from app.node_attempts attempt where workspace_id=$1),
             (select jsonb_agg(to_jsonb(node))::text
                from app.node_runs node where workspace_id=$1),
             (select jsonb_agg(to_jsonb(event))::text
                from app.run_events event where workspace_id=$1),
             (select jsonb_agg(to_jsonb(event))::text
                from app.outbox_events event where workspace_id=$1),
             (select jsonb_agg(to_jsonb(receipt))::text
                from app.inbox_receipts receipt where workspace_id=$1),
             (select jsonb_agg(to_jsonb(artifact))::text
                from app.artifacts artifact where workspace_id=$1)) surface`,
      [workspaceId],
    ),
  );
  const queueSurface = JSON.stringify([delivery, replay.toJSON()]);
  expect(durableSurface.rows[0]?.surface).not.toContain(plaintextSecret);
  expect(durableSurface.rows[0]?.surface).not.toContain(slackBotToken);
  expect(durableSurface.rows[0]?.surface).not.toContain(slackMessageText);
  expect(durableSurface.rows[0]?.surface).not.toContain(resendApiKey);
  expect(durableSurface.rows[0]?.surface).not.toContain(rotatedResendApiKey);
  expect(durableSurface.rows[0]?.surface).not.toContain(emailRecipient);
  expect(durableSurface.rows[0]?.surface).not.toContain(emailSubject);
  expect(durableSurface.rows[0]?.surface).not.toContain(emailText);
  expect(queueSurface).not.toContain(plaintextSecret);
  expect(
    JSON.stringify([slackDelivery, replayedSlackJob.toJSON()]),
  ).not.toContain(slackBotToken);
  expect(
    JSON.stringify([emailDelivery, replayedEmailJob.toJSON()]),
  ).not.toContain(resendApiKey);
  expect(JSON.stringify(telemetry)).not.toContain(plaintextSecret);
}
