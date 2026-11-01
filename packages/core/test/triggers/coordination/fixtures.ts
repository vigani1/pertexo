import { withTenantScopedClient } from '@pertexo/database/primitives';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
} from '@pertexo/workflow-engine';
import {
  formConfigSchema,
  type EventCoordinationPolicy,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { createFormStore } from '../../../src/triggers/forms/store.js';
import { createTriggerEventScanner } from '../../../src/triggers/coordination/scanner.repository.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  identity,
  actorId,
  apiUrl,
  queryAsOwner,
  apiPool,
  enforceTestRetention,
  purgeTestWorkspace,
} from '../../support/workflow-authoring.js';
export { queryAsOwner, apiPool, enforceTestRetention, purgeTestWorkspace };
export const config = parseDatabaseConfig({ connectionString: apiUrl, max: 4 });
export const checkpointFactory = (version: Readonly<{ id: string }>) => ({
  checkpoint: createCheckpoint({
    workflowVersionId: version.id,
    iterationBudget: 4998,
    nextEventSequence: 2,
  }),
});
export let store: ReturnType<typeof createFormStore>;
export let scanner: ReturnType<typeof createTriggerEventScanner>;
beforeAll(() => {
  store = createFormStore(config, checkpointFactory);
  scanner = createTriggerEventScanner(config);
});
afterAll(async () => {
  await Promise.all([store.close(), scanner.close()]);
});
export const key = { kind: 'run_input', path: '$.values.key' } as const;
export async function fixture(policy: EventCoordinationPolicy) {
  const workspaceId = randomUUID(),
    workflowId = randomUUID(),
    versionId = randomUUID();
  await identity.createWorkspaceWithOwner({
    id: workspaceId,
    name: 'Coordination proof',
    slug: `coord-${workspaceId}`,
    ownerUserId: actorId,
    idempotencyKey: workspaceId,
  });
  const node = (id: string, key: string) => ({
    id,
    definition: { key, version: 1 },
    configVersion: 1,
    config: {},
    position: { x: 0, y: 0 },
    inputMappings: {},
    connectionRefs: {},
  });
  const graph: WorkflowGraph = {
    settings: {},
    nodes: [
      {
        ...node('form', 'core.form'),
        config: formConfigSchema.parse({
          coordination: policy,
          fields: [
            { id: 'key', name: 'key', label: 'Key', type: 'text' },
            {
              id: 'message',
              name: 'message',
              label: 'Message',
              type: 'text',
              required: false,
            },
          ],
        }),
      },
      node('finish', 'core.terminate'),
    ],
    edges: [
      {
        id: 'end',
        source: { nodeId: 'form', port: 'out' },
        target: { nodeId: 'finish', port: 'in' },
      },
    ],
  };
  const compiled = buildWorkflowExecutable({
    graph,
    catalog: composeExecutableCatalog(CORE_NODE_CATALOG),
  });
  await queryAsOwner(
    'insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,$3,$4)',
    [workflowId, workspaceId, 'Coordination proof', actorId],
    workspaceId,
  );
  await queryAsOwner(
    'insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) values($1,$2,$3,1,$4::jsonb,$5::jsonb,$6,$7)',
    [
      versionId,
      workspaceId,
      workflowId,
      JSON.stringify(graph),
      JSON.stringify(compiled.envelope),
      compiled.checksum,
      actorId,
    ],
    workspaceId,
  );
  await queryAsOwner(
    'update app.workflows set published_version_id=$2 where id=$1',
    [workflowId, versionId],
    workspaceId,
  );
  const scope = { workspaceId, workflowId, versionId, actorId };
  return {
    ...scope,
    submit: (
      value = 'same',
      message = 'payload',
      idempotencyKey: string = randomUUID(),
    ) =>
      store.submit({
        ...scope,
        values: { key: value, message },
        idempotencyKey,
      }),
    query: <T extends Record<string, unknown>>(
      statement: string,
      args: readonly unknown[] = [],
    ) =>
      withTenantScopedClient(
        apiPool,
        { workspaceId, actorId },
        async (client) => (await client.query<T>(statement, [...args])).rows,
      ),
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export async function due(f: Fixture) {
  await f.query(
    "update app.trigger_coordinated_events set due_at=clock_timestamp()-interval '1 second' where status='pending'",
  );
}
export const scan = () => scanner.scanDue({ limit: 100, checkpointFactory });
export async function expireWindow(f: Fixture) {
  await f.query(
    "update app.trigger_event_windows set window_started_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day'",
  );
}
export async function finishRuns(f: Fixture) {
  await f.query(
    "update app.workflow_runs set status='canceled',completed_at=clock_timestamp() where workflow_id=$1 and status='queued'",
    [f.workflowId],
  );
}
export async function counts(f: Fixture) {
  return (
    await f.query(
      "select (select count(*)::int from app.workflow_runs where workflow_id=$1) runs,(select count(*)::int from app.trigger_coordinated_events) events,(select count(*)::int from app.usage_events where category='trigger.coordinated') usage",
      [f.workflowId],
    )
  )[0];
}
