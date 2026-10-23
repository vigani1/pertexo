import { it, expect } from 'vitest';

import {
  NodeAttemptDeliveryMismatchError,
  NodeAttemptStateCorruptError,
  asRuntime,
  nodeAttemptStore,
  randomUUID,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';
import { claimDispatchAttempt } from '../fixture.js';

export function registerCommitsReplaysOneExactTerminal(): void {
  it('commits and replays one exact terminal value and audits a mismatched delivery once', async () => {
    const lease = await claimDispatchAttempt('manual-completion', {
      sideEffectClass: 'safe',
      workerId: 'attempt-worker-completion',
    });
    const claimed = { kind: 'claimed' as const, lease };
    const runId = lease.runId;
    const admission = {
      attemptId: lease.attemptId,
      nodeRunId: lease.nodeRunId,
    };
    const delivery = {
      id: lease.delivery.outboxEventId,
      payload_checksum: lease.delivery.payloadChecksum,
    };
    const providerDispatchBinding = 'email:sha256:' + 'a'.repeat(64);
    await nodeAttemptStore.markDispatched({
      lease,
      providerDispatchBinding,
      signal: new AbortController().signal,
    });
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
             attempt.output_ref::jsonb=node.output_ref::jsonb output_matches,
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
    // Checkpoint pruning must not weaken immutable physical completion checks.
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `update app.run_checkpoints set scheduler_state=scheduler_state ||
         '{"invocations":[],"readySet":[],"admittedInvocationKeys":[]}'::jsonb
         where workspace_id=$1 and workflow_run_id=$2`,
        [workspaceA, runId],
      ),
    );
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
  });
}
