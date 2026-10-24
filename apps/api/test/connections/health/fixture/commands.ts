import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';
import { z } from 'zod';

import { restartEditorBrowserWorker } from '../../../browser/harness/worker-restart.js';

import type { ConnectionHealthCommandContext } from './contract.js';

const abandonedClaimSchema = z
  .object({
    phase: z.literal('health-publication-abandoned'),
    requestId: z.uuid(),
    success: z.literal(true),
    outboxEventId: z.uuid(),
    leaseToken: z.uuid(),
    leaseOwner: z.string().regex(/^health-abandoned-[0-9a-f-]{36}$/u),
    leaseExpiresAt: z.iso.datetime(),
    publishCalls: z.literal(0),
    releaseCalls: z.literal(0),
    markCalls: z.literal(0),
  })
  .strict();

function abandonPublication(child: ChildProcess, signal: AbortSignal) {
  const requestId = randomUUID();
  return new Promise<z.infer<typeof abandonedClaimSchema>>(
    (resolve, reject) => {
      let settled = false;
      const finish = (
        error?: Error,
        claim?: z.infer<typeof abandonedClaimSchema>,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('message', message);
        child.off('error', failed);
        child.off('exit', failed);
        signal.removeEventListener('abort', failed);
        if (error !== undefined) reject(error);
        else if (claim !== undefined) resolve(claim);
      };
      const failed = () => {
        finish(new Error('Owned health abandonment channel failed'));
      };
      const message = (value: unknown) => {
        const envelope = z
          .object({
            phase: z.literal('health-publication-abandoned'),
            requestId: z.literal(requestId),
          })
          .safeParse(value);
        if (!envelope.success) return;
        const parsed = abandonedClaimSchema.safeParse(value);
        if (parsed.success) finish(undefined, parsed.data);
        else finish(new Error('Owned health abandonment failed'));
      };
      const timer = setTimeout(failed, 15_000);
      child.on('message', message);
      child.on('error', failed);
      child.on('exit', failed);
      signal.addEventListener('abort', failed, { once: true });
      if (signal.aborted || !child.connected) {
        failed();
        return;
      }
      try {
        child.send(
          { phase: 'abandon-health-publication', requestId },
          (error) => {
            if (error !== null) failed();
          },
        );
      } catch {
        failed();
      }
    },
  );
}

export async function executeConnectionHealthCommand(
  input: ConnectionHealthCommandContext,
  path: string,
) {
  const {
    api,
    state,
    options,
    scope,
    held,
    wait,
    readConnection,
    readRun,
    startRun,
    completeHeld,
  } = input;

  scope.signal.throwIfAborted();
  if (path === '/reject-run') {
    state.commandStage = 'reject-provider-outcome';
    state.nextResponse = 'reject';
    const runId = await startRun();
    await wait(
      () => readRun(runId),
      (status) => status === 'failed',
    );
    expect((await readConnection()).status).toBe('active');
    const evidence = await api
      .database()
      .query<{ count: number }>(
        `select count(*)::int count from app.connection_health_observations where workspace_id=$1 and applied_at is null`,
        [state.workspaceId],
      );
    expect(evidence.rows[0]?.count).toBe(1);
    const callsBeforeRestart = state.sends;
    const accepted = async () =>
      (
        await api.database().query<{ run: unknown; attempts: unknown }>(
          `select row_to_json(run) run,(select json_agg(attempt order by attempt.id)
        from app.node_attempts attempt join app.node_runs node on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
        where attempt.workspace_id=$1 and node.workflow_run_id=run.id) attempts
        from app.workflow_runs run where run.workspace_id=$1 and run.id=$2`,
          [state.workspaceId, runId],
        )
      ).rows;
    const before = await accepted();
    const claim =
      options.abandonPublicationBeforeRestart === true
        ? await abandonPublication(state.worker, scope.signal)
        : undefined;
    const assertAbandoned = async () => {
      if (claim === undefined) return;
      const result = await api.database().query<{
        lease_token: string;
        lease_owner: string;
        future: boolean;
        publish_attempts: number;
        pending: boolean;
        observation_pending: boolean;
      }>(
        `select event.lease_token,event.lease_owner,event.lease_expires_at>clock_timestamp() future,
          event.publish_attempts,event.published_at is null and event.failed_at is null pending,
          observation.applied_at is null observation_pending
          from app.outbox_events event join app.connection_health_observations observation
          on observation.workspace_id=event.workspace_id and observation.id::text=event.payload->>'observationId'
          join app.node_attempts attempt on attempt.workspace_id=observation.workspace_id and attempt.id=observation.attempt_id
          join app.node_runs node on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
          where event.workspace_id=$1 and event.id=$2 and node.workflow_run_id=$3`,
        [state.workspaceId, claim.outboxEventId, runId],
      );
      expect(result.rows).toEqual([
        {
          lease_token: claim.leaseToken,
          lease_owner: claim.leaseOwner,
          future: true,
          publish_attempts: 1,
          pending: true,
          observation_pending: true,
        },
      ]);
      expect((await readConnection()).status).toBe('active');
      expect(state.sends).toBe(callsBeforeRestart);
    };
    await assertAbandoned();
    state.commandStage = 'restart-before-health-delivery';
    await restartEditorBrowserWorker(
      state.worker as Parameters<typeof restartEditorBrowserWorker>[0],
      randomUUID(),
      scope.signal,
    );
    await assertAbandoned();
    await wait(
      readConnection,
      (connection) => connection.status === 'reauthorization_required',
      claim === undefined ? 20000 : 45000,
    );
    if (claim !== undefined) {
      const recovered = await api.database().query<{
        published_after_expiry: boolean;
        publish_attempts: number;
        unleased: boolean;
        applied: boolean;
        receipts: number;
        transitions: number;
      }>(
        `select event.published_at >= $3::timestamptz published_after_expiry,event.publish_attempts,
          event.lease_token is null and event.lease_owner is null unleased,observation.applied_at is not null applied,
          (select count(*)::int from app.inbox_receipts where workspace_id=$1 and consumer_name='connection-health-worker'
          and message_id=event.id and completed_at is not null) receipts,
          (select count(*)::int from app.connection_events where workspace_id=$1 and connection_id=$4
          and event_type='connection.reauthorization_required' and metadata->>'source'='run') transitions
          from app.outbox_events event join app.connection_health_observations observation
          on observation.workspace_id=event.workspace_id and observation.id::text=event.payload->>'observationId'
          where event.workspace_id=$1 and event.id=$2`,
        [
          state.workspaceId,
          claim.outboxEventId,
          claim.leaseExpiresAt,
          state.connectionId,
        ],
      );
      expect(recovered.rows).toEqual([
        {
          published_after_expiry: true,
          publish_attempts: 2,
          unleased: true,
          applied: true,
          receipts: 1,
          transitions: 1,
        },
      ]);
      expect(await accepted()).toEqual(before);
    }
    expect(state.sends).toBe(callsBeforeRestart);
    return {
      restarted: true,
      abandonedPublicationRecovered: claim !== undefined,
      providerCalls: state.sends,
    };
  }
  if (path === '/hold-and-reject') {
    state.nextResponse = 'hold';
    state.staleRun = await startRun();
    await wait(
      () => Promise.resolve(held.size),
      (count) => count === 1,
    );
    state.nextResponse = 'reject';
    const runId = await startRun();
    await wait(
      () => readRun(runId),
      (status) => status === 'failed',
    );
    await wait(
      readConnection,
      (connection) => connection.status === 'reauthorization_required',
    );
    return { held: true };
  }
  if (path === '/release-stale-after-test') {
    expect((await readConnection()).status).toBe('active');
    await completeHeld(state.staleRun);
    expect((await readConnection()).status).toBe('active');
    return { healthy: true };
  }
  if (path === '/hold-before-rotation') {
    state.nextResponse = 'hold';
    state.rotationRun = await startRun();
    await wait(
      () => Promise.resolve(held.size),
      (count) => count === 1,
    );
    return { held: true };
  }
  if (path === '/release-stale-after-rotation') {
    await completeHeld(state.rotationRun);
    const connection = await readConnection();
    expect(connection.status).toBe('active');
    expect(connection.health.lastHealthyAt).toBeNull();
    return { unknown: true };
  }
  if (path === '/deny-membership') {
    await api
      .database()
      .query(
        "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
        [state.workspaceId, state.actorId],
      );
    return { denied: true };
  }
  throw new Error('Unknown health command');
}
