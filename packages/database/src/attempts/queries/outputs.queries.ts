import type { Pool } from 'pg';

import {
  NodeAttemptStateCorruptError,
  type NodeAttemptLoopDeclaration,
  type NodeAttemptStoredOutput,
  type NodeRunOutcome,
  type NodeRunStoredOutput,
  type NodeAttemptRunStore,
} from '../contract.js';
import {
  assertNotAborted,
  withWorkspaceReadClient,
} from '../transactions.repository.js';
import {
  parseStoredExecutionValue,
  storedExecutionValuesEqual,
} from '../../platform/stored-execution-value.js';

export async function readNodeAttemptLoopDeclaration(
  pool: Pool,
  input: Parameters<NodeAttemptRunStore['readLoopDeclaration']>[0],
): Promise<NodeAttemptLoopDeclaration | undefined> {
  assertNotAborted(input.signal);
  return withWorkspaceReadClient(
    pool,
    input.lease.workspaceId,
    input.signal,
    async (client) => {
      const declaration = await client.query<{
        attempt_id: string;
        attempt_output_ref: unknown;
        node_output_ref: unknown;
        node_id: string;
      }>(
        `select node.node_id,node.current_attempt_id as attempt_id,
                node.output_ref as node_output_ref,
                attempt.output_ref as attempt_output_ref
         from app.node_runs node
         join app.node_attempts attempt
           on attempt.workspace_id=node.workspace_id
          and attempt.id=node.current_attempt_id
          and attempt.node_run_id=node.id
         where node.workspace_id=$1 and node.workflow_run_id=$2
           and node.invocation_key=$3
           and attempt.status='succeeded'`,
        [
          input.lease.workspaceId,
          input.lease.runId,
          input.controlInvocationKey,
        ],
      );
      if (declaration.rows.length > 1) throw new NodeAttemptStateCorruptError();
      const row = declaration.rows[0];
      if (row === undefined) return undefined;
      if (
        !storedExecutionValuesEqual(row.node_output_ref, row.attempt_output_ref)
      )
        throw new NodeAttemptStateCorruptError();
      const stored = parseStoredExecutionValue(row.attempt_output_ref);
      if (stored.kind !== 'inline') throw new NodeAttemptStateCorruptError();
      return Object.freeze({
        nodeId: row.node_id,
        attemptId: row.attempt_id,
        output: stored.value,
      });
    },
  );
}

/** The stored outputs of succeeded attempts in the leased run, by attempt ID. */
export async function readNodeAttemptOutputs(
  pool: Pool,
  input: Parameters<NodeAttemptRunStore['readAttemptOutputs']>[0],
): Promise<readonly NodeAttemptStoredOutput[]> {
  assertNotAborted(input.signal);
  if (input.attemptIds.length === 0) return Object.freeze([]);
  return withWorkspaceReadClient(
    pool,
    input.lease.workspaceId,
    input.signal,
    async (client) => {
      const rows = await client.query<{
        attempt_id: string;
        output_ref: unknown;
      }>(
        `select attempt.id as attempt_id,attempt.output_ref
         from app.node_attempts attempt
         join app.node_runs node
           on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
         where attempt.workspace_id=$1 and node.workflow_run_id=$2
           and attempt.id=any($3::uuid[]) and attempt.status='succeeded'`,
        [
          input.lease.workspaceId,
          input.lease.runId,
          [...new Set(input.attemptIds)],
        ],
      );
      if (rows.rows.length !== new Set(input.attemptIds).size)
        throw new NodeAttemptStateCorruptError();
      return Object.freeze(
        rows.rows.map((row) => {
          const stored = parseStoredExecutionValue(row.output_ref);
          if (stored.kind !== 'inline')
            throw new NodeAttemptStateCorruptError();
          return Object.freeze({
            attemptId: row.attempt_id,
            output: stored.value,
          });
        }),
      );
    },
  );
}

export async function listNodeRunOutcomes(
  pool: Pool,
  input: Parameters<NodeAttemptRunStore['listNodeOutcomes']>[0],
): Promise<readonly NodeRunOutcome[]> {
  assertNotAborted(input.signal);
  return withWorkspaceReadClient(
    pool,
    input.lease.workspaceId,
    input.signal,
    async (client) => {
      const rows = await client.query<{
        invocation_key: string;
        status: 'succeeded' | 'skipped';
        output_bytes: number;
      }>(
        `select invocation_key,status,
                coalesce(octet_length(output_ref::text),0)::int as output_bytes
         from app.node_runs
         where workspace_id=$1 and workflow_run_id=$2 and node_id=$3
           and status in ('succeeded','skipped')`,
        [input.lease.workspaceId, input.lease.runId, input.nodeId],
      );
      return Object.freeze(
        rows.rows.map((row) =>
          Object.freeze({
            invocationKey: row.invocation_key,
            status: row.status,
            outputBytes: row.output_bytes,
          }),
        ),
      );
    },
  );
}

/** The stored outputs of succeeded step runs in the leased run, by key. */
export async function readNodeRunOutputs(
  pool: Pool,
  input: Parameters<NodeAttemptRunStore['readNodeOutputs']>[0],
): Promise<readonly NodeRunStoredOutput[]> {
  assertNotAborted(input.signal);
  const keys = [...new Set(input.invocationKeys)];
  if (keys.length === 0) return Object.freeze([]);
  return withWorkspaceReadClient(
    pool,
    input.lease.workspaceId,
    input.signal,
    async (client) => {
      const rows = await client.query<{
        invocation_key: string;
        output_ref: unknown;
      }>(
        `select invocation_key,output_ref from app.node_runs
         where workspace_id=$1 and workflow_run_id=$2
           and invocation_key=any($3::varchar[]) and status='succeeded'`,
        [input.lease.workspaceId, input.lease.runId, keys],
      );
      if (rows.rows.length !== keys.length)
        throw new NodeAttemptStateCorruptError();
      return Object.freeze(
        rows.rows.map((row) => {
          const stored = parseStoredExecutionValue(row.output_ref);
          if (stored.kind !== 'inline')
            throw new NodeAttemptStateCorruptError();
          return Object.freeze({
            invocationKey: row.invocation_key,
            output: stored.value,
          });
        }),
      );
    },
  );
}
