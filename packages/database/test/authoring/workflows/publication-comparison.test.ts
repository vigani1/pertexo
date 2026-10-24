import { draftWireRow } from '../../support/workflow-authoring/drafts.js';
import { folderScope } from '../../../src/tenant-access/resources/policy.js';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_WORKFLOW_GRAPH,
  type GraphValidationResult,
} from '@pertexo/workflow-model';
import { EMPTY_DEFINITION_CATALOG } from '@pertexo/workflow-model/server';
import { createWorkflowAuthoringReadStore } from '../../../src/authoring/workflows/reads.queries.js';
import { testExecutableCompiler } from '../../../src/authoring/test-executable-compiler.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workflowId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const versionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const graph = EMPTY_WORKFLOW_GRAPH;
const checksum = testExecutableCompiler(graph).checksum;
const valid: GraphValidationResult = {
  ok: true,
  issues: [],
  expandedInvocations: 0,
  worstCaseLoopIterations: 0,
};

async function compare(
  validation = valid,
  currentChecksum = checksum,
  {
    published = true,
    draftGraph = graph,
    liveGraph = graph,
  }: Readonly<{
    published?: boolean | undefined;
    draftGraph?: typeof graph | undefined;
    liveGraph?: typeof graph | undefined;
  }> = {},
) {
  const client = {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: workflowId }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          draftWireRow({
            workspace_id: workspaceId,
            workflow_id: workflowId,
            revision: 1,
            graph_json: draftGraph,
            updated_by: actorId,
            updated_at: new Date(),
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [{ setting: '30000', unit: 'ms' }] })
      .mockResolvedValueOnce({
        rows: published ? [[versionId, 3, checksum, liveGraph]] : [],
      }),
  } as unknown as PoolClient;
  const compiler = vi.fn(() => ({
    checksum: currentChecksum,
    executableJson: { graph },
  }));
  const store = createWorkflowAuthoringReadStore({
    requireReader: () =>
      Promise.resolve(folderScope(workspaceId, 'owner', [], [])),
    catalogs: {
      definitionCatalog: EMPTY_DEFINITION_CATALOG,
      validateAuthoringGraph: () => Promise.resolve(validation),
      executableCompiler: compiler,
    },
    transact: async (_workspace, _actor, operation) => operation(client),
  });
  return {
    result: await store.validateDraft(workspaceId, workflowId, actorId),
    compiler,
  };
}

describe('current publication comparison', () => {
  it('enables publication for changed notes without changing execution identity', async () => {
    const documented = {
      ...graph,
      notes: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          text: 'Review this path',
          position: { x: 0, y: 0 },
          size: { width: 320, height: 200 },
          color: 'teal' as const,
        },
      ],
    };
    expect(
      (
        await compare(valid, checksum, {
          published: true,
          draftGraph: documented,
        })
      ).result?.currentPublication?.matchesDraft,
    ).toBe(false);
    expect(
      (
        await compare(valid, checksum, {
          published: true,
          draftGraph: documented,
          liveGraph: documented,
        })
      ).result?.currentPublication?.matchesDraft,
    ).toBe(true);
  });
  it('uses the injected publication compiler, including changes in runtime/catalog identity', async () => {
    const unchanged = await compare();
    expect(unchanged.result?.currentPublication).toEqual({
      versionId,
      versionNumber: 3,
      matchesDraft: true,
    });
    const updatedRuntime = await compare(valid, `wf:sha256:${'f'.repeat(64)}`);
    expect(updatedRuntime.result?.currentPublication).toEqual({
      versionId,
      versionNumber: 3,
      matchesDraft: false,
    });
  });

  it('does not compile an invalid or unpublished draft merely to compare it', async () => {
    const invalid = await compare({
      ...valid,
      ok: false,
      issues: [{ code: 'cycle', path: '$', message: 'A cycle.' }],
    });
    expect(invalid.result?.currentPublication?.matchesDraft).toBe(false);
    expect(invalid.compiler).not.toHaveBeenCalled();
    const unpublished = await compare(valid, checksum, { published: false });
    expect(unpublished.result?.currentPublication).toBeNull();
    expect(unpublished.compiler).not.toHaveBeenCalled();
  });
});
