import { it, expect } from 'vitest';

import {
  asRuntime,
  checkpoint,
  nodeAttemptStore,
  randomUUID,
  ownedDeliveryStore,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';
import { claimDispatchAttempt } from '../fixture.js';

export function registerLoadsImmutablePersistedUpstreamValue(): void {
  it('loads the immutable persisted upstream value for an independent downstream attempt', async () => {
    const lease = await claimDispatchAttempt('manual-upstream', {
      sideEffectClass: 'safe',
      workerId: 'attempt-worker-upstream',
    });
    const runId = lease.runId;
    const invocationKey = lease.invocationKey;
    const admission = {
      attemptId: lease.attemptId,
      nodeRunId: lease.nodeRunId,
    };
    const httpArtifactOutput = {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: {
        kind: 'artifact',
        artifactId: randomUUID(),
        byteLength: 70_000,
        mediaType: 'application/octet-stream',
        sha256: 'a'.repeat(64),
      },
      finalOrigin: 'https://provider.example.test',
      redirectCount: 0,
    };
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.artifacts (
             id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
             status,expires_at,finalized_at
           ) values ($1,$2,'node-output',$3,'application/octet-stream',70000,$4,
             'available',now()+interval '1 day',now())`,
        [
          httpArtifactOutput.body.artifactId,
          workspaceA,
          `workspaces/${workspaceA}/artifacts/${httpArtifactOutput.body.artifactId}`,
          httpArtifactOutput.body.sha256,
        ],
      ),
    );
    await expect(
      nodeAttemptStore.complete({
        lease,
        outcome: { status: 'succeeded', output: httpArtifactOutput },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed' });

    const persistedArtifactId = httpArtifactOutput.body.artifactId;
    httpArtifactOutput.body.artifactId = randomUUID();
    const downstreamInvocationKey = `${versionA}|downstream|b:|i:`;
    const downstreamCommitted = await ownedDeliveryStore.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan: {
        expectedRevision: 1,
        expectedNextEventSequence: 4,
        consumedThroughEventSequence: 5,
        checkpoint: checkpoint({
          revision: 2,
          runStatus: 'running',
          nextEventSequence: 7,
          admittedInvocationKeys: [invocationKey, downstreamInvocationKey],
          invocations: [
            {
              invocationKey,
              nodeId: 'manual-upstream',
              status: 'succeeded',
              attemptNumber: 1,
              output: { kind: 'inline', attemptId: admission.attemptId },
            },
            {
              invocationKey: downstreamInvocationKey,
              nodeId: 'downstream',
              status: 'running',
              attemptNumber: 1,
            },
          ],
        }),
        events: [
          {
            sequence: 6,
            name: 'node.ready',
            occurredAt: '2026-08-21T00:00:01.000Z',
            invocationKey: downstreamInvocationKey,
            nodeId: 'downstream',
            attemptNumber: 0,
          },
        ],
        nodeRunAdmissions: [
          {
            invocationKey: downstreamInvocationKey,
            nodeId: 'downstream',
            sideEffectClass: 'safe',
          },
        ],
        attempts: [
          {
            invocationKey: downstreamInvocationKey,
            nodeId: 'downstream',
            attemptNumber: 1,
            sideEffectClass: 'safe',
          },
        ],
      },
    });
    if (downstreamCommitted.kind !== 'committed')
      throw new Error(
        `downstream fixture did not commit: ${JSON.stringify(downstreamCommitted)}`,
      );
    const downstreamAdmission = downstreamCommitted.admittedAttempts[0];
    if (downstreamAdmission === undefined)
      throw new Error('downstream attempt is missing');
    const downstreamOutbox = await asRuntime(
      workerBaseUrl,
      workspaceA,
      (client) =>
        client.query<{ id: string; payload_checksum: string }>(
          `select id,payload_checksum from app.outbox_events
             where workspace_id=$1 and aggregate_id=$2
               and job_name='execute-node-attempt'`,
          [workspaceA, downstreamAdmission.attemptId],
        ),
    );
    const downstreamDelivery = downstreamOutbox.rows[0];
    if (downstreamDelivery === undefined)
      throw new Error('downstream delivery is missing');
    const downstreamClaim = await nodeAttemptStore.claimDelivery({
      workspaceId: workspaceA,
      runId,
      nodeRunId: downstreamAdmission.nodeRunId,
      attemptId: downstreamAdmission.attemptId,
      delivery: {
        outboxEventId: downstreamDelivery.id,
        payloadChecksum: downstreamDelivery.payload_checksum,
      },
      leaseDurationSeconds: 30,
      workerId: 'attempt-worker-2',
      signal: new AbortController().signal,
    });
    if (downstreamClaim.kind !== 'claimed')
      throw new Error('downstream attempt was not claimed');
    await expect(
      nodeAttemptStore.loadInputs({
        lease: downstreamClaim.lease,
        upstreamNodeOutputs: [{ nodeId: 'manual-upstream', invocationKey }],
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      completedNodeOutputs: [
        {
          nodeId: 'manual-upstream',
          invocationKey,
          value: {
            status: 200,
            body: {
              kind: 'artifact',
              artifactId: persistedArtifactId,
              byteLength: 70_000,
              mediaType: 'application/octet-stream',
              sha256: 'a'.repeat(64),
            },
          },
        },
      ],
    });
  });
}
