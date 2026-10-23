import {
  workspaceId,
  connectionId,
  secretVersionId,
  slackConnectionId,
  slackSecretVersionId,
  emailConnectionId,
  emailSecretVersionId,
} from './environment.js';
import { withOwner, workerQuery } from './lifecycle.js';

export async function waitFor<T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMillis = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMillis;
  let value = await operation();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    value = await operation();
  }
  if (!predicate(value))
    throw new Error(`HTTP attempt proof timed out: ${JSON.stringify(value)}`);
  return value;
}

/**
 * Restore the shared schema fixture's provider rows to the immutable seeded
 * versions before each independently named scenario. Runtime state, requests,
 * queues, and run identities remain scenario-local; audit assertions use
 * per-scenario baselines because the immutable connection history is retained.
 */
export async function resetProviderScenarioIsolation(
  seeds: readonly Readonly<{
    connectionId: string;
    secretVersionId: string;
  }>[] = [
    { connectionId, secretVersionId },
    { connectionId: slackConnectionId, secretVersionId: slackSecretVersionId },
    { connectionId: emailConnectionId, secretVersionId: emailSecretVersionId },
  ],
): Promise<void> {
  await withOwner(async (client) => {
    await client.query(
      `update app.connections connection
          set current_secret_version_id=seed.secret_version_id,
              status='active',health_revision=health_revision+1,
              last_tested_at=null,last_healthy_at=null,last_error_code=null,
              last_run_observed_at=null,last_health_transition_at=clock_timestamp(),
              last_health_transition_source='rotation',updated_at=clock_timestamp()
         from unnest($2::uuid[],$3::uuid[]) seed(connection_id,secret_version_id)
        where connection.workspace_id=$1 and connection.id=seed.connection_id
          and connection.status<>'revoked'
          and connection.current_secret_version_id is distinct from seed.secret_version_id`,
      [
        workspaceId,
        seeds.map((seed) => seed.connectionId),
        seeds.map((seed) => seed.secretVersionId),
      ],
    );
  });
}

export async function attemptDelivery(
  runId: string,
  nodeId: string,
  expectedAttempts = 1,
) {
  const rows = await waitFor(
    () =>
      workerQuery<{
        attempt_id: string;
        node_run_id: string;
        outbox_id: string;
      }>(
        `select attempt.id attempt_id,node.id node_run_id,outbox.id outbox_id
         from app.node_runs node
         join app.node_attempts attempt
           on attempt.workspace_id=node.workspace_id and attempt.node_run_id=node.id
         join app.outbox_events outbox
           on outbox.workspace_id=attempt.workspace_id
          and outbox.aggregate_id=attempt.id
          and outbox.job_name='execute-node-attempt'
          where node.workspace_id=$1 and node.workflow_run_id=$2 and node.node_id=$3
          order by attempt.attempt_number desc`,
        [workspaceId, runId, nodeId],
      ),
    (value) => value.length === expectedAttempts,
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`${nodeId} attempt delivery missing`);
  return row;
}

export async function continuation(runId: string, excluded: readonly string[]) {
  const rows = await waitFor(
    () =>
      workerQuery<{ id: string }>(
        `select id from app.outbox_events
         where workspace_id=$1 and aggregate_id=$2
           and job_name='advance-workflow-run' and not (id=any($3::uuid[]))
         order by created_at,id`,
        [workspaceId, runId, excluded],
      ),
    (value) => value.length > 0,
  );
  if (rows[0] === undefined)
    throw new Error('coordinator continuation missing');
  return rows[0].id;
}
