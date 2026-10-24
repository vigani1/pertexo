import { createWorkspaceDatabase } from '../../../../src/database.js';
import { applyConnectionHealthObservation } from '../../../../src/connections/health/observations.repository.js';
import type { NodeAttemptLease } from '../../../../src/attempts/contract.js';
import {
  asOwner,
  databaseUrl,
  parseDatabaseConfig,
  workerBaseUrl,
  workspaceA,
} from '../../../runs/run-store/fixtures.js';

export async function healthCommand(lease: NodeAttemptLease) {
  const result = await asOwner(workspaceA, (client) =>
    client.query<{
      observation_id: string;
      outbox_event_id: string;
      payload_checksum: string;
    }>(
      `select observation.id observation_id,observation.outbox_event_id,outbox.payload_checksum
      from app.connection_health_observations observation join app.outbox_events outbox on outbox.id=observation.outbox_event_id
      where observation.workspace_id=$1 and observation.attempt_id=$2`,
      [workspaceA, lease.attemptId],
    ),
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Accepted health command missing');
  return {
    workspaceId: workspaceA,
    observationId: row.observation_id,
    delivery: {
      outboxEventId: row.outbox_event_id,
      payloadChecksum: row.payload_checksum,
    },
  };
}

export async function applyHealthCommand(
  input: Awaited<ReturnType<typeof healthCommand>>,
) {
  const database = createWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: databaseUrl(workerBaseUrl) }),
  );
  try {
    return await applyConnectionHealthObservation(database, input);
  } finally {
    await database.close();
  }
}

export async function readHealth(connectionId: string) {
  const result = await asOwner(workspaceA, (client) =>
    client.query<{
      status: string;
      health_revision: string;
      last_error_code: string | null;
      last_tested_at: Date | null;
      last_healthy_at: Date | null;
      last_run_observed_at: Date | null;
      current_secret_version_id: string;
    }>(
      `select status,health_revision,last_error_code,last_tested_at,last_healthy_at,last_run_observed_at,current_secret_version_id
      from app.connections where workspace_id=$1 and id=$2`,
      [workspaceA, connectionId],
    ),
  );
  return result.rows[0];
}

export async function countHealthTransitions(connectionId: string) {
  const result = await asOwner(workspaceA, (client) =>
    client.query<{ count: number }>(
      `select count(*)::int count from app.connection_events
    where workspace_id=$1 and connection_id=$2 and event_type='connection.reauthorization_required' and metadata->>'source'='run'`,
      [workspaceA, connectionId],
    ),
  );
  return result.rows[0]?.count;
}

export async function readAcceptedHealthExecution(lease: NodeAttemptLease) {
  const result = await asOwner(workspaceA, (client) =>
    client.query<{
      attempt: unknown;
      run: unknown;
    }>(
      `select row_to_json(attempt) attempt,row_to_json(run) run
     from app.node_attempts attempt join app.node_runs node on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
     join app.workflow_runs run on run.workspace_id=node.workspace_id and run.id=node.workflow_run_id
     where attempt.workspace_id=$1 and attempt.id=$2`,
      [workspaceA, lease.attemptId],
    ),
  );
  return result.rows[0];
}
