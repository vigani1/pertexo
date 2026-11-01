import {
  workspaceA,
  versionA,
  insertRun,
  checkpoint,
  ownedDeliveryStore,
  nodeAttemptStore,
  asRuntime,
  asOwner,
  workerBaseUrl,
} from '../../runs/run-store/fixtures.js';

export async function responseFixture(count = 2, waiting = true) {
  const runId = await insertRun({ triggerType: 'webhook' });
  const nodes = Array.from({ length: count }, (_, index) => ({
    nodeId: `respond-${String(index)}`,
    invocationKey: `${versionA}|respond-${String(index)}|b:|i:`,
  }));
  const committed = await ownedDeliveryStore.commitAdvancePlan({
    workspaceId: workspaceA,
    runId,
    workflowVersionId: versionA,
    signal: new AbortController().signal,
    plan: {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        workflowVersionId: versionA,
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 3 + count,
        admittedInvocationKeys: nodes.map((n) => n.invocationKey),
        invocations: nodes.map((n) => ({
          ...n,
          status: 'running',
          attemptNumber: 1,
        })),
      }),
      events: [
        {
          sequence: 2,
          name: 'run.started',
          occurredAt: '2026-08-21T00:00:00.000Z',
        },
        ...nodes.map((n, i) => ({
          ...n,
          sequence: 3 + i,
          name: 'node.ready',
          occurredAt: '2026-08-21T00:00:00.000Z',
          attemptNumber: 0,
        })),
      ],
      nodeRunAdmissions: nodes.map((n) => ({ ...n, sideEffectClass: 'safe' })),
      attempts: nodes.map((n) => ({
        ...n,
        attemptNumber: 1,
        sideEffectClass: 'safe',
      })),
    },
  });
  if (committed.kind !== 'committed')
    throw new Error('Response fixture did not commit');
  const leases = [];
  for (const admission of committed.admittedAttempts) {
    const result = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ id: string; payload_checksum: string }>(
        "select id,payload_checksum from app.outbox_events where workspace_id=$1 and aggregate_id=$2 and job_name='execute-node-attempt'",
        [workspaceA, admission.attemptId],
      ),
    );
    const delivery = result.rows[0];
    if (delivery === undefined)
      throw new Error('Response fixture dispatch missing');
    const claim = await nodeAttemptStore.claimDelivery({
      workspaceId: workspaceA,
      runId,
      nodeRunId: admission.nodeRunId,
      attemptId: admission.attemptId,
      delivery: {
        outboxEventId: delivery.id,
        payloadChecksum: delivery.payload_checksum,
      },
      leaseDurationSeconds: 30,
      workerId: `response-${admission.attemptId}`,
      signal: new AbortController().signal,
    });
    if (claim.kind !== 'claimed')
      throw new Error('Response fixture attempt missing');
    await nodeAttemptStore.markDispatched({
      lease: claim.lease,
      signal: new AbortController().signal,
    });
    leases.push(claim.lease);
  }
  if (waiting)
    await asOwner(workspaceA, (client) =>
      client.query(
        'insert into app.webhook_run_responses(workspace_id,run_id,wait_seconds) values($1,$2,1)',
        [workspaceA, runId],
      ),
    );
  const first = leases[0];
  if (first === undefined)
    throw new Error('Response fixture first attempt missing');
  return { runId, leases, first };
}
export function response(body = 'first') {
  return {
    statusCode: 200,
    contentType: 'text/plain' as const,
    headers: { 'x-request-id': 'response' },
    body,
  };
}
