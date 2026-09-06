import { createHash } from 'node:crypto';

import { describe, it, expect } from 'vitest';

import {
  NodeAttemptConnectionFenceError,
  NodeAttemptDeliveryMismatchError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptStateCorruptError,
  actorId,
  asAdmin,
  asOwner,
  asRuntime,
  checkpoint,
  createDueNodeWakeupScanner,
  databaseUrl,
  insertRun,
  nodeAttemptStore,
  parseDatabaseConfig,
  randomUUID,
  store,
  versionA,
  workerBaseUrl,
  workspaceA,
} from './coordinator-run-store.fixtures.js';

async function claimDispatchAttempt(nodeId: string) {
  const runId = await insertRun({
    inputRef: { schemaVersion: 1, kind: 'inline', value: { nodeId } },
  });
  const invocationKey = `${versionA}|${nodeId}|b:|i:`;
  const committed = await store.commitAdvancePlan({
    workspaceId: workspaceA,
    runId,
    workflowVersionId: versionA,
    signal: new AbortController().signal,
    plan: {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 4,
        admittedInvocationKeys: [invocationKey],
        invocations: [
          {
            invocationKey,
            nodeId,
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      events: [
        {
          schemaVersion: 1,
          sequence: 2,
          name: 'run.started',
          occurredAt: '2026-08-21T00:00:00.000Z',
        },
        {
          schemaVersion: 1,
          sequence: 3,
          name: 'node.ready',
          occurredAt: '2026-08-21T00:00:00.000Z',
          invocationKey,
          nodeId,
          attemptNumber: 0,
        },
      ],
      nodeRunAdmissions: [{ invocationKey, nodeId, sideEffectClass: 'unsafe' }],
      attempts: [
        {
          invocationKey,
          nodeId,
          attemptNumber: 1,
          sideEffectClass: 'unsafe',
        },
      ],
    },
  });
  if (committed.kind !== 'committed')
    throw new Error('dispatch fixture did not commit');
  const admission = committed.admittedAttempts[0];
  if (admission === undefined) throw new Error('dispatch attempt missing');
  const outbox = await asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query<{ id: string; payload_checksum: string }>(
      `select id,payload_checksum from app.outbox_events
         where workspace_id=$1 and aggregate_id=$2
           and job_name='execute-node-attempt'`,
      [workspaceA, admission.attemptId],
    ),
  );
  const delivery = outbox.rows[0];
  if (delivery === undefined) throw new Error('dispatch delivery missing');
  const claimed = await nodeAttemptStore.claimDelivery({
    workspaceId: workspaceA,
    runId,
    nodeRunId: admission.nodeRunId,
    attemptId: admission.attemptId,
    delivery: {
      outboxEventId: delivery.id,
      payloadChecksum: delivery.payload_checksum,
    },
    leaseDurationSeconds: 30,
    workerId: `dispatch-worker-${nodeId}`,
    signal: new AbortController().signal,
  });
  if (claimed.kind !== 'claimed')
    throw new Error('dispatch attempt was not claimed');
  return claimed.lease;
}

async function seedDispatchConnection(input: {
  connectionId: string;
  providerKey: 'http' | 'slack';
  authType: 'http_headers' | 'slack_bot_token';
  secretVersionId: string;
}) {
  await asOwner(workspaceA, async (client) => {
    await client.query(
      `insert into app.connections (
           id,workspace_id,provider_key,name,auth_type,status,
           current_secret_version_id,created_by
         ) values ($1,$2,$3,$4,$5,'active',$6,$7)`,
      [
        input.connectionId,
        workspaceA,
        input.providerKey,
        `Dispatch fence ${input.providerKey} ${input.connectionId}`,
        input.authType,
        input.secretVersionId,
        actorId,
      ],
    );
    await client.query(
      `insert into app.connection_secret_versions (
           id,workspace_id,connection_id,schema_version,kms_key_reference,
           encrypted_data_key,ciphertext,nonce,auth_tag,created_by
         ) values ($1,$2,$3,1,'kms','a','a',$4,$5,$6)`,
      [
        input.secretVersionId,
        workspaceA,
        input.connectionId,
        'a'.repeat(16),
        'a'.repeat(22),
        actorId,
      ],
    );
  });
}

function dispatchBinding(
  providerKey: 'http' | 'slack',
  connectionId: string,
  secretVersionId: string,
) {
  return `${providerKey}:v1:sha256:${createHash('sha256')
    .update(`${providerKey}\0${connectionId}\0${secretVersionId}`)
    .digest('hex')}`;
}

describe('Coordinator node-attempt persistence invariants', () => {
  it('claims one transport-bound ready attempt with a durable fence', async () => {
    const runId = await insertRun({
      inputRef: {
        schemaVersion: 1,
        kind: 'inline',
        value: { hello: 'world' },
      },
    });
    const invocationKey = `${versionA}|manual|b:|i:`;
    const committed = await store.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan: {
        expectedRevision: 0,
        expectedNextEventSequence: 2,
        consumedThroughEventSequence: 1,
        checkpoint: checkpoint({
          revision: 1,
          runStatus: 'running',
          nextEventSequence: 4,
          admittedInvocationKeys: [invocationKey],
          invocations: [
            {
              invocationKey,
              nodeId: 'manual',
              status: 'running',
              attemptNumber: 1,
            },
          ],
        }),
        events: [
          {
            schemaVersion: 1,
            sequence: 2,
            name: 'run.started',
            occurredAt: '2026-08-21T00:00:00.000Z',
          },
          {
            schemaVersion: 1,
            sequence: 3,
            name: 'node.ready',
            occurredAt: '2026-08-21T00:00:00.000Z',
            invocationKey,
            nodeId: 'manual',
            attemptNumber: 0,
          },
        ],
        nodeRunAdmissions: [
          { invocationKey, nodeId: 'manual', sideEffectClass: 'safe' },
        ],
        attempts: [
          {
            invocationKey,
            nodeId: 'manual',
            attemptNumber: 1,
            sideEffectClass: 'safe',
          },
        ],
      },
    });
    if (committed.kind !== 'committed')
      throw new Error('fixture did not commit');
    const admission = committed.admittedAttempts[0];
    if (admission === undefined) throw new Error('fixture attempt missing');
    const outbox = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ id: string; payload_checksum: string }>(
        `select id,payload_checksum from app.outbox_events
           where workspace_id=$1 and aggregate_id=$2
             and job_name='execute-node-attempt'`,
        [workspaceA, admission.attemptId],
      ),
    );
    const delivery = outbox.rows[0];
    if (delivery === undefined) throw new Error('fixture delivery missing');

    const claimed = await nodeAttemptStore.claimDelivery({
      workspaceId: workspaceA,
      runId,
      nodeRunId: admission.nodeRunId,
      attemptId: admission.attemptId,
      delivery: {
        outboxEventId: delivery.id,
        payloadChecksum: delivery.payload_checksum,
      },
      leaseDurationSeconds: 30,
      workerId: 'attempt-worker-1',
      signal: new AbortController().signal,
    });
    expect(claimed).toMatchObject({
      kind: 'claimed',
      lease: {
        attemptId: admission.attemptId,
        attemptNumber: 1,
        fenceToken: 1,
        invocationKey,
        nodeId: 'manual',
        nodeRunId: admission.nodeRunId,
        runId,
        sideEffectClass: 'safe',
        workflowVersionId: versionA,
      },
    });
    if (claimed.kind !== 'claimed') throw new Error('attempt was not claimed');
    expect(claimed.lease.providerDispatchUnresolved).toBeUndefined();
    await expect(
      nodeAttemptStore.claimDelivery({
        workspaceId: workspaceA,
        runId,
        nodeRunId: admission.nodeRunId,
        attemptId: admission.attemptId,
        delivery: {
          outboxEventId: delivery.id,
          payloadChecksum: delivery.payload_checksum,
        },
        leaseDurationSeconds: 30,
        workerId: 'attempt-worker-2',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });
    await expect(
      nodeAttemptStore.loadInputs({
        lease: claimed.lease,
        upstreamNodeOutputs: [],
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      abortRequested: false,
      completedNodeOutputs: [],
      runInput: { hello: 'world' },
    });
    const connectionId = randomUUID();
    const secretVersionId = randomUUID();
    const nextSecretVersionId = randomUUID();
    await asOwner(workspaceA, async (client) => {
      await client.query(
        `insert into app.connections (
             id,workspace_id,provider_key,name,auth_type,status,
             current_secret_version_id,created_by
           ) values ($1,$2,'email',$3,'resend_api_key','active',$4,$5)`,
        [
          connectionId,
          workspaceA,
          `Dispatch fence ${connectionId}`,
          secretVersionId,
          actorId,
        ],
      );
      await client.query(
        `insert into app.connection_secret_versions (
             id,workspace_id,connection_id,schema_version,kms_key_reference,
             encrypted_data_key,ciphertext,nonce,auth_tag,created_by
           ) values ($1,$2,$3,1,'kms','a','a',$4,$5,$6)`,
        [
          secretVersionId,
          workspaceA,
          connectionId,
          'a'.repeat(16),
          'a'.repeat(22),
          actorId,
        ],
      );
    });
    const connectionFence = {
      connectionId,
      expectedProviderKey: 'email',
      expectedAuthType: 'resend_api_key',
      secretVersionId,
    } as const;
    const providerDispatchBinding = 'email:v1:sha256:' + 'a'.repeat(64);
    await asAdmin((client) =>
      client.query(`update app.workspaces set status='suspended' where id=$1`, [
        workspaceA,
      ]),
    );
    await expect(
      nodeAttemptStore.markDispatched({
        lease: claimed.lease,
        connectionFence,
        providerDispatchBinding,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptConnectionFenceError);
    await asAdmin((client) =>
      client.query(`update app.workspaces set status='active' where id=$1`, [
        workspaceA,
      ]),
    );
    await expect(
      asAdmin(async (client) => {
        const evidence = await client.query<{
          dispatch_marked_at: Date | null;
          provider_dispatch_binding: string | null;
        }>(
          `select attempt.dispatch_marked_at,node.provider_dispatch_binding
             from app.node_attempts attempt
             join app.node_runs node on node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
          [workspaceA, claimed.lease.attemptId],
        );
        return evidence.rows[0];
      }),
    ).resolves.toEqual({
      dispatch_marked_at: null,
      provider_dispatch_binding: null,
    });
    const dispatched = await nodeAttemptStore.markDispatched({
      lease: claimed.lease,
      connectionFence,
      providerDispatchBinding,
      signal: new AbortController().signal,
    });
    expect(dispatched.dispatchedAt).toBeInstanceOf(Date);
    expect(claimed.lease.providerDispatchUnresolved).toBeUndefined();
    await expect(
      nodeAttemptStore.markDispatched({
        lease: claimed.lease,
        connectionFence,
        providerDispatchBinding,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(dispatched);
    await expect(
      nodeAttemptStore.markDispatched({
        lease: claimed.lease,
        providerDispatchBinding: 'email:v1:sha256:' + 'b'.repeat(64),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptDispatchBindingMismatchError);
    await asOwner(workspaceA, async (client) => {
      await client.query(
        `insert into app.connection_secret_versions (
             id,workspace_id,connection_id,schema_version,kms_key_reference,
             encrypted_data_key,ciphertext,nonce,auth_tag,created_by
           ) values ($1,$2,$3,1,'kms','b','b',$4,$5,$6)`,
        [
          nextSecretVersionId,
          workspaceA,
          connectionId,
          'b'.repeat(16),
          'b'.repeat(22),
          actorId,
        ],
      );
      await client.query(
        `update app.connections set current_secret_version_id=$3
           where workspace_id=$1 and id=$2`,
        [workspaceA, connectionId, nextSecretVersionId],
      );
    });
    await expect(
      nodeAttemptStore.markDispatched({
        lease: claimed.lease,
        connectionFence,
        providerDispatchBinding,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptConnectionFenceError);
    await asOwner(workspaceA, (client) =>
      client.query(
        `update app.connections
           set current_secret_version_id=$3,status='revoked'
           where workspace_id=$1 and id=$2`,
        [workspaceA, connectionId, secretVersionId],
      ),
    );
    await expect(
      nodeAttemptStore.markDispatched({
        lease: claimed.lease,
        connectionFence,
        providerDispatchBinding,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptConnectionFenceError);
    const heartbeat = await nodeAttemptStore.heartbeat({
      lease: claimed.lease,
      leaseDurationSeconds: 30,
      signal: new AbortController().signal,
    });
    expect(heartbeat.abortRequested).toBe(false);
    expect(heartbeat.leaseExpiresAt).toBeInstanceOf(Date);
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
    const completed = await nodeAttemptStore.complete({
      lease: claimed.lease,
      outcome: { status: 'succeeded', output: httpArtifactOutput },
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      signal: new AbortController().signal,
    });
    if (completed.kind !== 'committed')
      throw new Error('attempt completion did not commit');
    expect(completed.outboxEventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const terminal = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        attempt_status: string;
        node_status: string;
        output_matches: boolean;
        terminal_events: number;
        provider_dispatch_binding: string | null;
        continuation_outbox: number;
        completed_receipts: number;
      }>(
        `select
             attempt.status attempt_status,node.status node_status,
             node.provider_dispatch_binding,
             attempt.output_ref=node.output_ref output_matches,
             (select count(*)::int from app.run_events
               where workflow_run_id=$1 and type='node.succeeded') terminal_events,
             (select count(*)::int from app.outbox_events
               where aggregate_id=$1 and job_name='advance-workflow-run'
                 and id=$5) continuation_outbox,
             (select count(*)::int from app.inbox_receipts
               where message_id=$4 and completed_at is not null) completed_receipts
           from app.node_attempts attempt
           join app.node_runs node on node.id=attempt.node_run_id
           where attempt.workspace_id=$2 and attempt.id=$3`,
        [
          runId,
          workspaceA,
          admission.attemptId,
          delivery.id,
          completed.outboxEventId,
        ],
      ),
    );
    expect(terminal.rows[0]).toEqual({
      attempt_status: 'succeeded',
      provider_dispatch_binding: providerDispatchBinding,
      node_status: 'succeeded',
      output_matches: true,
      terminal_events: 1,
      continuation_outbox: 1,
      completed_receipts: 1,
    });
    await expect(
      nodeAttemptStore.complete({
        lease: claimed.lease,
        outcome: { status: 'succeeded', output: httpArtifactOutput },
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate', outboxEventId: null });
    await expect(
      nodeAttemptStore.complete({
        lease: claimed.lease,
        outcome: { status: 'succeeded', output: { hello: 'changed' } },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
    await expect(
      nodeAttemptStore.claimDelivery({
        workspaceId: workspaceA,
        runId,
        nodeRunId: admission.nodeRunId,
        attemptId: admission.attemptId,
        delivery: {
          outboxEventId: delivery.id,
          payloadChecksum: delivery.payload_checksum,
        },
        leaseDurationSeconds: 30,
        workerId: 'attempt-worker-1',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });
    await expect(
      nodeAttemptStore.claimDelivery({
        workspaceId: workspaceA,
        runId: randomUUID(),
        nodeRunId: admission.nodeRunId,
        attemptId: admission.attemptId,
        delivery: {
          outboxEventId: delivery.id,
          payloadChecksum: delivery.payload_checksum,
        },
        leaseDurationSeconds: 30,
        workerId: 'attempt-worker-1',
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptDeliveryMismatchError);
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ count: number }>(
          `select count(*)::int count
             from app.transport_security_audit_facts
             where workspace_id=$1 and consumer_name='node-attempt-worker'
               and message_id=$2`,
          [workspaceA, delivery.id],
        ),
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });

    const persistedArtifactId = httpArtifactOutput.body.artifactId;
    httpArtifactOutput.body.artifactId = randomUUID();
    const downstreamInvocationKey = `${versionA}|downstream|b:|i:`;
    const downstreamCommitted = await store.commitAdvancePlan({
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
              nodeId: 'manual',
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
            schemaVersion: 1,
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
        upstreamNodeOutputs: [{ nodeId: 'manual', invocationKey }],
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      completedNodeOutputs: [
        {
          nodeId: 'manual',
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

  it('keeps HTTP and Slack dispatch markers fenced across credential rotation', async () => {
    for (const target of [
      { providerKey: 'http', authType: 'http_headers' },
      { providerKey: 'slack', authType: 'slack_bot_token' },
    ] as const) {
      const lease = await claimDispatchAttempt(
        `dispatch-${target.providerKey}`,
      );
      const connectionId = randomUUID();
      const secretVersionId = randomUUID();
      const rotatedSecretVersionId = randomUUID();
      await seedDispatchConnection({
        connectionId,
        providerKey: target.providerKey,
        authType: target.authType,
        secretVersionId,
      });
      const connectionFence = {
        connectionId,
        expectedProviderKey: target.providerKey,
        expectedAuthType: target.authType,
        secretVersionId,
      } as const;
      const providerDispatchBinding = dispatchBinding(
        target.providerKey,
        connectionId,
        secretVersionId,
      );
      const preflight = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ fence_current: boolean }>(
          `select app.connection_dispatch_fence_current($1,$2,$3,$4,$5)
             fence_current`,
          [
            workspaceA,
            connectionId,
            target.providerKey,
            target.authType,
            secretVersionId,
          ],
        ),
      );
      expect(preflight.rows[0]?.fence_current).toBe(true);

      await asOwner(workspaceA, async (client) => {
        await client.query(
          `insert into app.connection_secret_versions (
               id,workspace_id,connection_id,schema_version,kms_key_reference,
               encrypted_data_key,ciphertext,nonce,auth_tag,created_by
             ) values ($1,$2,$3,1,'kms','b','b',$4,$5,$6)`,
          [
            rotatedSecretVersionId,
            workspaceA,
            connectionId,
            'b'.repeat(16),
            'b'.repeat(22),
            actorId,
          ],
        );
        await client.query(
          `update app.connections set current_secret_version_id=$3
             where workspace_id=$1 and id=$2`,
          [workspaceA, connectionId, rotatedSecretVersionId],
        );
      });

      await expect(
        nodeAttemptStore.markDispatched({
          lease,
          connectionFence,
          providerDispatchBinding,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(NodeAttemptConnectionFenceError);
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{
            dispatch_marked_at: Date | null;
            provider_dispatch_binding: string | null;
          }>(
            `select attempt.dispatch_marked_at,node.provider_dispatch_binding
               from app.node_attempts attempt
               join app.node_runs node on node.id=attempt.node_run_id
              where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceA, lease.attemptId],
          ),
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            dispatch_marked_at: null,
            provider_dispatch_binding: null,
          },
        ],
      });

      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.connections set current_secret_version_id=$3
             where workspace_id=$1 and id=$2`,
          [workspaceA, connectionId, secretVersionId],
        ),
      );
      const dispatched = await nodeAttemptStore.markDispatched({
        lease,
        connectionFence,
        providerDispatchBinding,
        signal: new AbortController().signal,
      });
      expect(dispatched.dispatchedAt).toBeInstanceOf(Date);
      const verified = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          dispatch_marked_at: Date | null;
          provider_dispatch_binding: string | null;
        }>(
          `select attempt.dispatch_marked_at,node.provider_dispatch_binding
             from app.node_attempts attempt
             join app.node_runs node on node.id=attempt.node_run_id
            where attempt.workspace_id=$1 and attempt.id=$2`,
          [workspaceA, lease.attemptId],
        ),
      );
      expect(verified.rows).toHaveLength(1);
      expect(verified.rows[0]?.dispatch_marked_at).toBeInstanceOf(Date);
      expect(verified.rows[0]?.provider_dispatch_binding).toBe(
        providerDispatchBinding,
      );
    }
  }, 30_000);

  it('atomically suspends an attempt from database time without an early wakeup', async () => {
    const runId = await insertRun({
      inputRef: { schemaVersion: 1, kind: 'inline', value: { held: true } },
    });
    const invocationKey = `${versionA}|wait|b:|i:`;
    const committed = await store.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan: {
        expectedRevision: 0,
        expectedNextEventSequence: 2,
        consumedThroughEventSequence: 1,
        checkpoint: checkpoint({
          revision: 1,
          runStatus: 'running',
          nextEventSequence: 4,
          admittedInvocationKeys: [invocationKey],
          invocations: [
            {
              invocationKey,
              nodeId: 'wait',
              status: 'running',
              attemptNumber: 1,
            },
          ],
        }),
        events: [
          {
            schemaVersion: 1,
            sequence: 2,
            name: 'run.started',
            occurredAt: '2026-08-21T00:00:00.000Z',
          },
          {
            schemaVersion: 1,
            sequence: 3,
            name: 'node.ready',
            occurredAt: '2026-08-21T00:00:00.000Z',
            invocationKey,
            nodeId: 'wait',
            attemptNumber: 0,
          },
        ],
        nodeRunAdmissions: [
          { invocationKey, nodeId: 'wait', sideEffectClass: 'safe' },
        ],
        attempts: [
          {
            admissionKind: 'execute',
            invocationKey,
            nodeId: 'wait',
            attemptNumber: 1,
            sideEffectClass: 'safe',
          },
        ],
      },
    });
    if (committed.kind !== 'committed')
      throw new Error('fixture did not commit');
    const admission = committed.admittedAttempts[0];
    if (admission === undefined) throw new Error('fixture attempt missing');
    const outbox = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ id: string; payload_checksum: string }>(
        `select id,payload_checksum from app.outbox_events
           where workspace_id=$1 and aggregate_id=$2 and job_name='execute-node-attempt'`,
        [workspaceA, admission.attemptId],
      ),
    );
    const delivery = outbox.rows[0];
    if (delivery === undefined) throw new Error('fixture delivery missing');
    const claimed = await nodeAttemptStore.claimDelivery({
      workspaceId: workspaceA,
      runId,
      nodeRunId: admission.nodeRunId,
      attemptId: admission.attemptId,
      delivery: {
        outboxEventId: delivery.id,
        payloadChecksum: delivery.payload_checksum,
      },
      leaseDurationSeconds: 30,
      workerId: 'attempt-worker-wait',
      signal: new AbortController().signal,
    });
    if (claimed.kind !== 'claimed') throw new Error('attempt was not claimed');

    const suspended = await nodeAttemptStore.complete({
      lease: claimed.lease,
      outcome: {
        status: 'suspended',
        output: { held: true },
        durationSeconds: 1,
      },
      signal: new AbortController().signal,
    });
    expect(suspended).toMatchObject({ kind: 'committed' });
    await expect(
      nodeAttemptStore.complete({
        lease: claimed.lease,
        outcome: {
          status: 'suspended',
          output: { held: true },
          durationSeconds: 1,
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate', outboxEventId: null });

    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        attempt_status: string;
        node_status: string;
        resume_at: Date;
        wait_kind: string;
        no_early_resume: boolean;
        waiting_events: number;
        suspension_outboxes: number;
      }>(
        `select attempt.status attempt_status,node.status node_status,node.resume_at,node.wait_kind,
                  node.resume_at > clock_timestamp() no_early_resume,
                  (select count(*)::int from app.run_events
                    where workflow_run_id=$1 and type='node.waiting') waiting_events,
                  (select count(*)::int from app.outbox_events
                    where aggregate_id=$1 and job_name='advance-workflow-run'
                      and id=$3) suspension_outboxes
           from app.node_attempts attempt
           join app.node_runs node on node.id=attempt.node_run_id
           where attempt.id=$2`,
        [runId, admission.attemptId, suspended.outboxEventId],
      ),
    );
    expect(proof.rows[0]).toMatchObject({
      attempt_status: 'succeeded',
      node_status: 'waiting',
      wait_kind: 'node_wait',
      no_early_resume: true,
      waiting_events: 1,
      suspension_outboxes: 1,
    });
    expect(proof.rows[0]?.resume_at).toBeInstanceOf(Date);
    const scanner = createDueNodeWakeupScanner(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 1,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    );
    try {
      await scanner.claimDueWakeups(100);
      const afterScan = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ count: number }>(
          `select count(*)::int count from app.outbox_events
             where aggregate_id=$1 and job_name='advance-workflow-run'`,
          [runId],
        ),
      );
      expect(afterScan.rows[0]?.count).toBe(2);
    } finally {
      await scanner.close();
    }

    const resumeAt = proof.rows[0]?.resume_at.toISOString();
    if (resumeAt === undefined) throw new Error('resume time missing');
    await expect(
      store.commitAdvancePlan({
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
            runStatus: 'waiting',
            nextEventSequence: 7,
            admittedInvocationKeys: [invocationKey],
            invocations: [
              {
                invocationKey,
                nodeId: 'wait',
                status: 'waiting',
                attemptNumber: 1,
                resumeAt,
                waitKind: 'node_wait',
                output: { kind: 'inline', attemptId: admission.attemptId },
              },
            ],
          }),
          events: [
            {
              schemaVersion: 1,
              sequence: 6,
              name: 'run.waiting',
              occurredAt: '2026-08-21T00:00:01.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 2 });
    // The persisted wait is derived from PostgreSQL time and duplicated inside
    // the immutable checkpoint, so this intentionally crosses the real clock.
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const dueScanner = createDueNodeWakeupScanner(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 1,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    );
    try {
      await dueScanner.claimDueWakeups(100);
    } finally {
      await dueScanner.close();
    }
    const resumed = await store.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan: {
        expectedRevision: 2,
        expectedNextEventSequence: 7,
        consumedThroughEventSequence: 6,
        checkpoint: checkpoint({
          revision: 3,
          runStatus: 'running',
          nextEventSequence: 8,
          admittedInvocationKeys: [invocationKey],
          invocations: [
            {
              invocationKey,
              nodeId: 'wait',
              status: 'running',
              attemptNumber: 2,
              output: { kind: 'inline', attemptId: admission.attemptId },
            },
          ],
        }),
        events: [
          {
            schemaVersion: 1,
            sequence: 7,
            name: 'node.ready',
            occurredAt: resumeAt,
            invocationKey,
            nodeId: 'wait',
            attemptNumber: 1,
          },
        ],
        nodeRunAdmissions: [],
        attempts: [
          {
            admissionKind: 'wait_resume',
            invocationKey,
            nodeId: 'wait',
            attemptNumber: 2,
            sideEffectClass: 'safe',
          },
        ],
      },
    });
    if (resumed.kind !== 'committed') throw new Error('resume did not commit');
    const resumeAdmission = resumed.admittedAttempts[0];
    if (resumeAdmission === undefined)
      throw new Error('resume attempt missing');
    const resumeDelivery = await asRuntime(
      workerBaseUrl,
      workspaceA,
      (client) =>
        client.query<{ id: string; payload_checksum: string }>(
          `select id,payload_checksum from app.outbox_events
           where aggregate_id=$1 and job_name='execute-node-attempt'`,
          [resumeAdmission.attemptId],
        ),
    );
    const resumeOutbox = resumeDelivery.rows[0];
    if (resumeOutbox === undefined) throw new Error('resume delivery missing');
    const resumeClaim = await nodeAttemptStore.claimDelivery({
      workspaceId: workspaceA,
      runId,
      nodeRunId: resumeAdmission.nodeRunId,
      attemptId: resumeAdmission.attemptId,
      delivery: {
        outboxEventId: resumeOutbox.id,
        payloadChecksum: resumeOutbox.payload_checksum,
      },
      leaseDurationSeconds: 30,
      workerId: 'attempt-worker-wait-resume',
      signal: new AbortController().signal,
    });
    if (resumeClaim.kind !== 'claimed')
      throw new Error('resume was not claimed');
    expect(resumeClaim.lease.admissionKind).toBe('wait_resume');
    await expect(
      nodeAttemptStore.loadInputs({
        lease: resumeClaim.lease,
        upstreamNodeOutputs: [],
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      abortRequested: false,
      resumeOutput: { held: true },
    });
    await expect(
      nodeAttemptStore.complete({
        lease: resumeClaim.lease,
        outcome: { status: 'succeeded', output: { held: true } },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    const terminal = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        attempts: number;
        node_status: string;
        wait_kind: string | null;
      }>(
        `select node.status node_status,node.wait_kind,count(attempt.id)::int attempts
           from app.node_runs node join app.node_attempts attempt on attempt.node_run_id=node.id
           where node.id=$1 group by node.id`,
        [resumeAdmission.nodeRunId],
      ),
    );
    expect(terminal.rows[0]).toEqual({
      attempts: 2,
      node_status: 'succeeded',
      wait_kind: null,
    });
  });
});
