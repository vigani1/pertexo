import { expect } from 'vitest';
import { z } from 'zod';
import type { Pool } from 'pg';
import { workflowGraphSchema } from '@pertexo/contracts';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import {
  composeExecutableCatalog,
  verifyWorkflowExecutable,
} from '@pertexo/workflow-engine';

export const collectionEvidenceSchema = z.strictObject({
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  workflowVersionId: z.uuid(),
  runId: z.uuid(),
  importedWorkflowId: z.uuid(),
  importedVersionId: z.uuid(),
  importedRunId: z.uuid(),
  filterId: z.string(),
  previewId: z.uuid(),
});
export const dateEvidenceSchema = z.strictObject({
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  workflowVersionId: z.uuid(),
  runId: z.uuid(),
  dateId: z.string(),
  previewId: z.uuid(),
});
async function readVersion(
  database: Pool,
  workspaceId: string,
  versionId: string,
) {
  const row = (
    await database.query<{
      graph_json: unknown;
      executable_json: unknown;
      checksum: string;
    }>(
      'select graph_json,executable_json,checksum from app.workflow_versions where workspace_id=$1 and id=$2',
      [workspaceId, versionId],
    )
  ).rows[0];
  if (row === undefined)
    throw new Error('Browser-authored transform version missing');
  const executable = verifyWorkflowExecutable({
    envelope: row.executable_json,
    checksum: row.checksum,
    catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
  });
  expect(
    executable.envelope.graph.nodes.every(
      (node) => node.definition.version === 1 && node.executor.version === 1,
    ),
  ).toBe(true);
  return workflowGraphSchema.parse(row.graph_json);
}

export async function verifyTransformEvidence(
  database: Pool,
  collection: z.infer<typeof collectionEvidenceSchema>,
  date: z.infer<typeof dateEvidenceSchema>,
) {
  const original = await readVersion(
    database,
    collection.workspaceId,
    collection.workflowVersionId,
  );
  const imported = await readVersion(
    database,
    collection.workspaceId,
    collection.importedVersionId,
  );
  expect(imported).toEqual(original);
  expect(original.nodes.map((node) => node.definition.key).sort()).toEqual([
    'core.filter',
    'core.manual',
    'core.sort',
    'core.summarize',
    'core.terminate',
    'core.unique',
  ]);
  expect(
    original.nodes.find((node) => node.id === collection.filterId),
  ).toMatchObject({
    config: { path: '$.paid', operator: 'equals' },
    inputMappings: {
      items: { kind: 'run_input', path: '$.invoices' },
      value: { kind: 'run_input', path: '$.paid' },
    },
  });
  const groups = [
    { key: 'EUR', count: 2, sum: 40, min: 10, max: 30, average: 20 },
    { key: 'USD', count: 1, sum: 20, min: 20, max: 20, average: 20 },
  ];
  const runs = (
    await database.query<{
      id: string;
      workflow_id: string;
      workflow_version_id: string;
      status: string;
      output_ref: unknown;
    }>(
      'select id,workflow_id,workflow_version_id,status,output_ref from app.workflow_runs where workspace_id=$1 and id=any($2::uuid[])',
      [collection.workspaceId, [collection.runId, collection.importedRunId]],
    )
  ).rows;
  expect(runs).toHaveLength(2);
  expect(runs.find((run) => run.id === collection.runId)).toMatchObject({
    workflow_id: collection.workflowId,
    workflow_version_id: collection.workflowVersionId,
    status: 'succeeded',
  });
  expect(runs.find((run) => run.id === collection.importedRunId)).toMatchObject(
    {
      workflow_id: collection.importedWorkflowId,
      workflow_version_id: collection.importedVersionId,
      status: 'succeeded',
    },
  );
  const stopId = original.nodes.find(
    (node) => node.definition.key === 'core.terminate',
  )?.id;
  if (stopId === undefined)
    throw new Error('Browser-authored Stop step missing');
  const stopped = (
    await database.query<{ status: string; output_ref: unknown }>(
      'select status,output_ref from app.node_runs where workspace_id=$1 and workflow_run_id=any($2::uuid[]) and node_id=$3',
      [
        collection.workspaceId,
        [collection.runId, collection.importedRunId],
        stopId,
      ],
    )
  ).rows;
  expect(stopped).toEqual(
    [0, 1].map(() => ({
      status: 'succeeded',
      output_ref: { kind: 'inline', value: { result: groups } },
    })),
  );
  const filter = (
    await database.query<{
      status: string;
      input_ref: unknown;
      output_ref: unknown;
    }>(
      'select status,input_ref,output_ref from app.node_runs where workspace_id=$1 and workflow_run_id=$2 and node_id=$3',
      [collection.workspaceId, collection.runId, collection.filterId],
    )
  ).rows[0];
  const preview = (
    await database.query<{
      status: string;
      node_id: string;
      output_ref: unknown;
    }>(
      'select status,node_id,output_ref from app.preview_runs where workspace_id=$1 and id=$2',
      [collection.workspaceId, collection.previewId],
    )
  ).rows[0];
  expect(filter).toMatchObject({
    status: 'succeeded',
    output_ref: { kind: 'inline', value: { inputCount: 5, removedCount: 1 } },
  });
  expect(preview).toEqual({
    status: 'succeeded',
    node_id: collection.filterId,
    output_ref: filter?.output_ref,
  });
  const dateGraph = await readVersion(
    database,
    date.workspaceId,
    date.workflowVersionId,
  );
  expect(dateGraph.nodes).toHaveLength(1);
  expect(dateGraph.nodes[0]).toMatchObject({
    id: date.dateId,
    definition: { key: 'core.date', version: 1 },
    config: { operation: 'to_iso' },
    inputMappings: {
      value: {
        kind: 'expression',
        language: 'jsonata',
        expression: '$number(runInput.text)',
      },
    },
  });
  const dateRun = (
    await database.query<{
      status: string;
      input_ref: unknown;
      output_ref: unknown;
    }>(
      'select status,input_ref,output_ref from app.node_runs where workspace_id=$1 and workflow_run_id=$2 and node_id=$3',
      [date.workspaceId, date.runId, date.dateId],
    )
  ).rows[0];
  expect(dateRun).toEqual({
    status: 'succeeded',
    input_ref: { kind: 'inline', value: { value: 1767225600000 } },
    output_ref: {
      kind: 'inline',
      value: { value: '2026-01-01T00:00:00.000Z' },
    },
  });
  const datePreview = (
    await database.query<{ status: string; output_ref: unknown }>(
      'select status,output_ref from app.preview_runs where workspace_id=$1 and id=$2',
      [date.workspaceId, date.previewId],
    )
  ).rows[0];
  expect(datePreview).toEqual({
    status: 'succeeded',
    output_ref: dateRun?.output_ref,
  });
}
