import { randomUUID } from 'node:crypto';

import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  buildWorkflowTestExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { createWorkflowAuthoringDatabase } from '../../../../src/authoring/workflows/repository.js';
import { createWorkflowInputCaseDatabase } from '../../../../src/authoring/input-cases/repository.js';
import { createWorkflowTestSuiteScanner } from '../../../../src/previews/suites/scanner.js';
import { createWorkflowExecutionReader } from '../../../../src/runs/queries/execution/source.queries.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { serializeStoredExecutionValue } from '@pertexo/database/primitives';
import {
  apiUrl,
  dispatcherUrl,
  queryAsOwner,
  workspaceId,
  actorId,
} from '../../../support/workflow-authoring.js';

export const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);

export const config = () =>
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 });

export const maintenance = () =>
  parseDatabaseConfig({ connectionString: dispatcherUrl, max: 2 });

export let database: ReturnType<typeof createWorkflowAuthoringDatabase>;

export let cases: ReturnType<typeof createWorkflowInputCaseDatabase>;

export let scanner: Awaited<ReturnType<typeof createWorkflowTestSuiteScanner>>;

export let reader: ReturnType<typeof createWorkflowExecutionReader>;

export const query = <T extends Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
) => queryAsOwner<T>(sql, values, workspaceId);

export async function fixture(count = 2) {
  const workflowId = randomUUID(),
    versionId = randomUUID();
  const graph = parseWorkflowGraphDraft({
    settings: {},
    nodes: ['core.manual', 'core.set'].map((key, index) => ({
      id: index === 0 ? 'start' : 'set',
      definition: { key, version: 1 },
      position: { x: index * 200, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    })),
    edges: [
      {
        id: 'link',
        source: { nodeId: 'start', port: 'out' },
        target: { nodeId: 'set', port: 'in' },
      },
    ],
  });
  const executable = buildWorkflowExecutable({ graph, catalog });
  await query(
    "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Suite proof',$3)",
    [workflowId, workspaceId, actorId],
  );
  await query(
    'insert into app.workflow_drafts(workflow_id,workspace_id,graph_json,updated_by) values($1,$2,$3::jsonb,$4)',
    [workflowId, workspaceId, JSON.stringify(graph), actorId],
  );
  await query(
    'insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) values($1,$2,$3,1,$4::jsonb,$5::jsonb,$6,$7)',
    [
      versionId,
      workspaceId,
      workflowId,
      JSON.stringify(graph),
      JSON.stringify(executable.envelope),
      executable.checksum,
      actorId,
    ],
  );
  const scope = { workspaceId, workflowId, actorId };
  const records = [];
  for (let index = 0; index < count; index++)
    records.push(
      await cases.createCase({
        ...scope,
        workflowVersionId: versionId,
        name: `Case ${String(index + 1)}`,
        input: { amount: index + 1 },
        expectations: {
          outcome: 'succeeds',
          assertions: [
            {
              source: { kind: 'final' },
              path: '$.amount',
              operator: 'equals',
              expected: index + 1,
            },
          ],
        },
        idempotencyKey: randomUUID(),
      }),
    );
  return { scope, records };
}

export async function command(f: Awaited<ReturnType<typeof fixture>>) {
  const p = await database.workflowTestSuites.prepare(f.scope);
  return {
    ...f.scope,
    idempotencyKey: randomUUID(),
    request: {
      expectedRevision: p.draftRevision,
      expectedSamples: p.samples,
      expectedEffectfulSteps: p.effectfulSteps.map((step) => step.nodeId),
      expectedCases: p.cases.map(({ id, revision }) => ({ id, revision })),
      expectedVariableSetRevision: p.variableSetRevision,
      signature: p.signature,
      acknowledgeSideEffects: false,
    },
  };
}

export async function due(suiteId: string) {
  await query(
    "update app.workflow_test_suites set next_check_at=clock_timestamp()-interval '1 second' where id=$1",
    [suiteId],
  );
}

export async function complete(
  runId: string,
  value: unknown,
  status = 'succeeded',
) {
  await query(
    'update app.workflow_runs set status=$2,completed_at=clock_timestamp(),output_ref=$3::jsonb where id=$1',
    [runId, status, serializeStoredExecutionValue({ kind: 'inline', value })],
  );
}

export function runId(
  detail: Awaited<ReturnType<typeof database.workflowTestSuites.get>>,
  ordinal: number,
) {
  const value = detail.cases[ordinal]?.runId;
  if (value === undefined || value === null)
    throw new Error('Case is not admitted');
  return value;
}

export async function beforeAllFixture1() {
  database = createWorkflowAuthoringDatabase(config(), {
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
  cases = createWorkflowInputCaseDatabase(config());
  scanner = await createWorkflowTestSuiteScanner(config(), maintenance());
  reader = createWorkflowExecutionReader(config());
}

export function afterAllFixture2() {
  return Promise.all([
    database.close(),
    cases.close(),
    scanner.close(),
    reader.close(),
  ]);
}

export async function restartSuiteScanner(): Promise<void> {
  await scanner.close();
  scanner = await createWorkflowTestSuiteScanner(config(), maintenance());
}
