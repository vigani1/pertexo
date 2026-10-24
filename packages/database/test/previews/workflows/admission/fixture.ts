import { createWorkflowRunDatabase } from '../../../../src/runs/runs.repository.js';
import { createWorkspaceDatabase } from '../../../../src/database.js';

import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  buildWorkflowTestExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { createWorkflowAuthoringDatabase } from '../../../../src/authoring/workflows/repository.js';
import { parseDatabaseConfig } from '../../../../src/config.js';
import { createWorkflowExecutionReader } from '../../../../src/runs/queries/execution/source.queries.js';
import { createPublishedWorkflowReader } from '../../../../src/runs/queries/execution/published.queries.js';

import {
  apiUrl,
  actorId,
  workspaceId,
  randomUUID,
  queryAsOwner as rawQuery,
} from '../../../support/workflow-authoring.js';

export const query = <T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
) => rawQuery<T>(statement, parameters, workspaceId);

export const execute = async (
  statement: string,
  parameters: readonly unknown[] = [],
) => {
  await query(statement, parameters);
};

export const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);

export let runs: ReturnType<typeof createWorkflowRunDatabase>;

export let workspaceDatabase: ReturnType<typeof createWorkspaceDatabase>;

export let database: ReturnType<typeof createWorkflowAuthoringDatabase>;

export let reader: ReturnType<typeof createWorkflowExecutionReader>;

export let publications: ReturnType<typeof createPublishedWorkflowReader>;

export async function fixture() {
  const workflowId = randomUUID();
  const node = (id: string, key: string) => ({
    id,
    definition: { key, version: 1 },
    configVersion: 1,
    config: {},
    position: { x: 0, y: 0 },
    inputMappings: {},
    connectionRefs: {},
  });
  const graph = parseWorkflowGraphDraft({
    settings: {},
    nodes: [node('start', 'core.manual'), node('set', 'core.set')],
    edges: [
      {
        id: 'link',
        source: { nodeId: 'start', port: 'out' },
        target: { nodeId: 'set', port: 'in' },
      },
    ],
  });
  await execute(
    `insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Draft test proof',$3)`,
    [workflowId, workspaceId, actorId],
  );
  await execute(
    `insert into app.workflow_drafts(workflow_id,workspace_id,graph_json,updated_by) values($1,$2,$3::jsonb,$4)`,
    [workflowId, workspaceId, JSON.stringify(graph), actorId],
  );
  return { scope: { workflowId, workspaceId, actorId }, graph };
}

export async function command(f: Awaited<ReturnType<typeof fixture>>) {
  const preparation = await database.workflowTests.prepare(f.scope);
  return {
    ...f.scope,
    idempotencyKey: randomUUID(),
    request: {
      expectedRevision: preparation.draftRevision,
      expectedSamples: preparation.samples,
      expectedEffectfulSteps: preparation.effectfulSteps.map(
        (step) => step.nodeId,
      ),
      input: { synthetic: 'test input' },
      acknowledgeSideEffects: false,
    },
  };
}

export function beforeAllFixture1() {
  const config = parseDatabaseConfig({ connectionString: apiUrl, max: 4 });
  runs = createWorkflowRunDatabase(config);
  workspaceDatabase = createWorkspaceDatabase(config);
  database = createWorkflowAuthoringDatabase(config, {
    executableCompiler: (graph) => {
      const executable = buildWorkflowExecutable({ graph, catalog });
      return {
        checksum: executable.checksum,
        executableJson: executable.envelope,
      };
    },
    workflowTestCompiler: (graph, pins) =>
      buildWorkflowTestExecutable({ graph, pins, catalog }),
  });
  reader = createWorkflowExecutionReader(config);
  publications = createPublishedWorkflowReader(config);
}

export async function afterAllFixture2() {
  await Promise.all([
    database.close(),
    reader.close(),
    publications.close(),
    runs.close(),
    workspaceDatabase.close(),
  ]);
}
