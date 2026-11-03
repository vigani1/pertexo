import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { ArtifactMetadataNotFoundError } from '../../../src/artifacts/artifact.errors.js';
import {
  beforeAllFixture1,
  afterAllFixture2,
  createWebhookScenario,
  ownerQuery,
  workspaceId,
  hash,
  checkpointFactory,
  webhook,
} from './fixture.js';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);

it('refuses external artifact descriptors outside the webhook workflow before creating a run', async () => {
  const scenario = await createWebhookScenario();
  const artifactId = randomUUID();
  const file = {
    kind: 'artifact',
    artifactId,
    byteLength: 4,
    mediaType: 'application/octet-stream',
    sha256: 'a'.repeat(64),
  };
  await ownerQuery(
    "insert into app.artifacts(id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,expires_at,finalized_at) values($1,$2,'run-output',$3,$4,4,$5,'available',clock_timestamp()+interval '1 day',clock_timestamp())",
    [
      artifactId,
      workspaceId,
      `workspaces/${workspaceId}/artifacts/${artifactId}`,
      file.mediaType,
      file.sha256,
    ],
  );
  await expect(
    webhook.acceptVerifiedDelivery({
      verification: scenario.verification,
      verifiedSecretVersionId: scenario.verification.currentSecret.id,
      requestFingerprint: hash(randomUUID()),
      runInput: { body: { file } },
      bodyBytes: 200,
      checkpointFactory,
      signal: new AbortController().signal,
    }),
  ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
  const rows = await ownerQuery(
    'select id from app.workflow_runs where workspace_id=$1 and workflow_id=$2',
    [workspaceId, scenario.verification.workflowId],
  );
  expect(rows.rows).toEqual([]);
});
