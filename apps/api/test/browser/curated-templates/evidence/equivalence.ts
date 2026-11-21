import { writeFile } from 'node:fs/promises';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';
import { expect } from 'vitest';
import type { Api } from './contract.js';

const qualificationFile = process.env.CURATED_INLINE_EQUIVALENCE_FILE;
const inlineEnabled = process.env.WORKFLOW_COORDINATOR_INLINE_STEPS === 'true';
const inlineVersions = new Map(
  PLATFORM_NODE_CATALOG.definitions
    .filter(({ execution }) => execution === 'inline')
    .map(({ definition }) => [definition.key, definition.version]),
);

export function qualificationGraph(graph: WorkflowGraph): WorkflowGraph {
  return { ...graph, nodes: graph.nodes.map(qualifyNode) };
}

function qualifyNode(node: WorkflowNode): WorkflowNode {
  const version = inlineVersions.get(node.definition.key);
  const definition =
    version === undefined ? node.definition : { ...node.definition, version };
  const structured =
    node.structured === undefined
      ? {}
      : {
          structured: {
            ...node.structured,
            body: {
              ...node.structured.body,
              nodes: node.structured.body.nodes.map(qualifyNode),
            },
          },
        };
  return { ...node, ...structured, definition };
}

export const compareInlineExecution = qualificationFile !== undefined;

export async function recordCuratedExecution(
  api: Api,
  workspaceId: string,
  runs: Readonly<Record<string, string>>,
) {
  if (qualificationFile === undefined) return;
  const snapshots = [];
  for (const [name, runId] of Object.entries(runs)) {
    const snapshot = await readExecution(api, workspaceId, runId);
    snapshots.push({ name, ...snapshot });
  }
  if (inlineEnabled)
    expect(
      snapshots.flatMap(({ inlineAttempts }) => inlineAttempts).length,
    ).toBeGreaterThan(0);
  else
    expect(snapshots.flatMap(({ inlineAttempts }) => inlineAttempts)).toEqual(
      [],
    );
  await writeFile(
    qualificationFile,
    JSON.stringify(snapshots.map(({ logical }) => logical)),
  );
}

async function readExecution(api: Api, workspaceId: string, runId: string) {
  const database = api.database();
  const params = [workspaceId, runId];
  const [run, nodes, attempts, events] = await Promise.all([
    database.query<{
      status: string;
      output_ref: unknown;
      error_summary: unknown;
      workflow_version_id: string;
    }>(
      `select status, output_ref, error_summary, workflow_version_id from app.workflow_runs
        where workspace_id=$1 and id=$2`,
      params,
    ),
    database.query<{
      id: string;
      invocation_key: string;
      logical: Record<string, unknown>;
    }>(
      `select id, invocation_key, to_jsonb(node) - array[
         'id','workspace_id','workflow_run_id','created_at','updated_at','started_at',
         'completed_at','provider_idempotency_key','provider_dispatch_binding',
         'resume_at','retry_due_at','due_wakeup_at'
       ] || jsonb_build_object(
         'provider_dispatch_kind', split_part(node.provider_dispatch_binding, ':', 1)
       ) as logical from app.node_runs node
       where workspace_id=$1 and workflow_run_id=$2 order by invocation_key`,
      params,
    ),
    database.query<{
      id: string;
      invocation_key: string;
      attempt_number: number;
      lease_owner: string | null;
      lease_expires_at: unknown;
      dispatch_marked_at: unknown;
      fence_token: string;
      delivered: boolean;
      logical: Record<string, unknown>;
    }>(
      `select attempt.id, node.invocation_key, attempt.attempt_number, attempt.lease_owner,
              attempt.lease_expires_at, attempt.dispatch_marked_at, attempt.fence_token,
              exists(select from app.outbox_events outbox
                       where outbox.workspace_id=$1 and outbox.aggregate_id=attempt.id
                         and outbox.job_name='execute-node-attempt') as delivered,
              to_jsonb(attempt) - array[
         'id','workspace_id','node_run_id','created_at','updated_at','started_at',
         'completed_at','lease_owner','lease_expires_at','dispatch_marked_at',
         'fence_token','provider_idempotency_key'
       ] || jsonb_build_object('dispatched', attempt.dispatch_marked_at is not null)
         as logical from app.node_attempts attempt
       join app.node_runs node on node.id=attempt.node_run_id and node.workspace_id=attempt.workspace_id
       where node.workspace_id=$1 and node.workflow_run_id=$2
       order by node.invocation_key, attempt.attempt_number`,
      params,
    ),
    database.query<{ sequence: number; type: string; payload: unknown }>(
      `select sequence, type, payload - array[
         'occurredAt','startedAt','completedAt','dueAt','retryDueAt','durationMillis','fenceToken'
       ] as payload from app.run_events
       where workspace_id=$1 and workflow_run_id=$2 order by sequence`,
      params,
    ),
  ]);
  const record = run.rows[0];
  if (record === undefined) throw new Error('Curated run is missing');
  const ids = new Map([
    [runId, 'run'],
    [record.workflow_version_id, 'version'],
    [workspaceId, 'workspace'],
  ]);
  for (const { id, invocation_key } of nodes.rows) {
    const scope = invocation_key.replace(record.workflow_version_id, 'version');
    ids.set(id, scope);
    ids.set(invocation_key, scope);
  }
  for (const { id, invocation_key, attempt_number } of attempts.rows) {
    const invocation = ids.get(invocation_key);
    if (invocation === undefined)
      throw new Error('Curated attempt cannot be matched to an invocation');
    ids.set(id, `${invocation}/attempt/${String(attempt_number)}`);
  }
  for (const [index, { sequence }] of events.rows.entries())
    expect(sequence).toBe(index + 1);
  const inlineAttempts = attempts.rows.filter(({ delivered }) => !delivered);
  for (const attempt of inlineAttempts)
    expect(attempt).toMatchObject({
      lease_owner: null,
      lease_expires_at: null,
      dispatch_marked_at: null,
      fence_token: '0',
    });
  return {
    inlineAttempts: inlineAttempts.map(({ invocation_key }) => invocation_key),
    logical: {
      run: normalize(record, ids),
      nodes: nodes.rows.map(({ logical }) => normalize(logical, ids)),
      attempts: attempts.rows.map(({ invocation_key, logical }) => ({
        invocation: normalize(invocation_key, ids),
        record: normalize(logical, ids),
      })),
      events: events.rows.map(({ type, payload }) => ({
        type,
        payload: normalize(payload, ids),
      })),
    },
  };
}

function normalize(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => normalize(item, ids));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalize(item, ids)]),
  );
}
