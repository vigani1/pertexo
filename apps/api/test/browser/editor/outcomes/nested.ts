import { expect } from 'vitest';

import { workflowGraphSchema } from '@pertexo/contracts';

import { fixtureState } from '../fixture/state.js';
import type {
  EditorBrowserApi,
  EditorBrowserJourneyContext,
} from '../fixture/contract.js';

export async function verifyEditorNestedOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  expect(fixtureState.evidence).toBeDefined();
  const persisted = await api.database().query<{
    status: string;
    workflow_id: string;
    workspace_id: string;
    workflow_version_id: string;
  }>('select status, workflow_id, workspace_id, workflow_version_id from app.workflow_runs where id=$1', [fixtureState.evidence?.runId]);
  expect(persisted.rows).toEqual([
    {
      status: 'succeeded',
      workflow_id: fixtureState.evidence?.workflowId,
      workspace_id: fixtureState.evidence?.workspaceId,
      workflow_version_id: fixtureState.evidence?.workflowVersionId,
    },
  ]);
  const nodes = await api.database().query<{
    node_id: string;
    status: string;
    invocation_key: string;
    branch_context: unknown;
  }>(
    `select node_id,status,invocation_key,branch_context from app.node_runs
       where workflow_run_id=$1 and workspace_id=$2`,
    [fixtureState.evidence?.runId, fixtureState.evidence?.workspaceId],
  );
  expect(nodes.rows).toHaveLength(8);
  expect(nodes.rows.every((node) => node.status === 'succeeded')).toBe(true);
  const leaves = nodes.rows.filter(
    (node) => node.node_id === fixtureState.evidence?.leafId,
  );
  expect(leaves).toHaveLength(4);
  expect(new Set(leaves.map((node) => node.invocation_key)).size).toBe(4);
  expect(leaves.map((node) => node.branch_context)).toEqual(
    expect.arrayContaining(
      [0, 1].flatMap((outer) =>
        [0, 1].map((inner) => ({
          branchPath: [],
          iterationPath: [
            { loopNodeId: fixtureState.evidence?.outerId, ordinal: outer },
            { loopNodeId: fixtureState.evidence?.innerId, ordinal: inner },
          ],
        })),
      ),
    ),
  );
  expect(
    nodes.rows.filter(
      (node) => node.node_id === fixtureState.evidence?.innerId,
    ),
  ).toHaveLength(2);
  await verifyEditorDraftConflictOutcome(api);
}

async function verifyEditorDraftConflictOutcome(api: EditorBrowserApi) {
  const draft = await api
    .database()
    .query<{ revision: number; graph_json: unknown }>(
      'select revision,graph_json from app.workflow_drafts where workflow_id=$1 and workspace_id=$2',
      [fixtureState.evidence?.workflowId, fixtureState.evidence?.workspaceId],
    );
  expect(draft.rows).toHaveLength(1);
  expect(draft.rows[0]?.revision).toBe(
    fixtureState.evidence?.finalDraftRevision,
  );
  expect(fixtureState.evidence?.finalDraftRevision).toBeGreaterThan(
    fixtureState.evidence?.conflictRevision ?? 0,
  );
  const draftRoot = workflowGraphSchema
    .parse(draft.rows[0]?.graph_json)
    .nodes.find((node) => node.id === fixtureState.evidence?.rootId);
  expect(draftRoot).toMatchObject({
    label: 'Local source choice',
    inputMappings: {
      literalProof: { kind: 'literal', value: 'unpublished-after-run' },
    },
  });
  const versions = await api
    .database()
    .query<{ id: string; graph_json: unknown }>(
      'select id,graph_json from app.workflow_versions where workflow_id=$1 and workspace_id=$2',
      [fixtureState.evidence?.workflowId, fixtureState.evidence?.workspaceId],
    );
  expect(versions.rows).toHaveLength(1);
  expect(versions.rows[0]?.id).toBe(fixtureState.evidence?.workflowVersionId);
  expect(
    workflowGraphSchema
      .parse(versions.rows[0]?.graph_json)
      .nodes.find((node) => node.id === fixtureState.evidence?.rootId),
  ).toMatchObject({
    label: 'Mapping source',
    inputMappings: {
      literalProof: { kind: 'literal', value: 'from-real-browser' },
    },
  });
  const counts = await api
    .database()
    .query<{ count: number }>(
      'select count(*)::int as count from app.workflow_runs where workflow_id=$1 and workspace_id=$2',
      [fixtureState.evidence?.workflowId, fixtureState.evidence?.workspaceId],
    );
  expect(counts.rows).toEqual([{ count: 1 }]);
  process.stdout.write(
    `Live browser durable evidence ${JSON.stringify(fixtureState.evidence)}\n`,
  );
}
