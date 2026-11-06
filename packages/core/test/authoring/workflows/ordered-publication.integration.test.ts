import { readFile } from 'node:fs/promises';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import { createCoreNodeRegistry } from '@pertexo/nodes-core/server';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  verifyWorkflowExecutable,
  executeNodeAttempt,
  invocationKey,
} from '@pertexo/workflow-engine';
import { afterAll, expect, it } from 'vitest';
import {
  actorId,
  apiUrl,
  createWorkflowAuthoringStore,
  parseDatabaseConfig,
  currentRepresentationTag,
  draftNode,
  emptyGraph,
  randomUUID,
  workspaceId,
  queryAsOwner,
} from '../../support/workflow-authoring.js';

const authoring = createWorkflowAuthoringStore(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  {
    executableCompiler: (graph) => {
      const compiled = buildWorkflowExecutable({
        graph,
        catalog: composeExecutableCatalog(CORE_NODE_CATALOG),
      });
      return { checksum: compiled.checksum, executableJson: compiled.envelope };
    },
    definitionCatalog: {
      definitions: ['core.manual', 'core.set'].map((key) => ({
        key,
        version: 1,
      })),
    },
  },
);
afterAll(() => authoring.close());

it('publishes changed field order, crosses legacy identity once, and preserves notes snapshots', async () => {
  const name = { kind: 'literal', value: 'Ada' } as const;
  const qty = { kind: 'literal', value: 2 } as const;
  const graph = {
    ...emptyGraph,
    nodes: [
      {
        ...draftNode('manual'),
        definition: { key: 'core.manual', version: 1 },
        config: {},
      },
      {
        ...draftNode('set'),
        definition: { key: 'core.set', version: 1 },
        config: {},
        inputMappings: { name, qty },
      },
    ],
    edges: [
      {
        id: 'link',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'set', port: 'in' },
      },
    ],
  };
  const created = await authoring.createWorkflow({
    actorId,
    workspaceId,
    name: 'Ordered fields',
    emptyGraph: graph,
    idempotencyKey: randomUUID(),
  });
  const scope = { actorId, workspaceId, workflowId: created.workflowId };
  const tag = () =>
    currentRepresentationTag(authoring, workspaceId, {
      scopedWorkflowId: created.workflowId,
      scopedActorId: actorId,
    });
  const publish = async () =>
    authoring.publishWorkflow({
      ...scope,
      representationTag: await tag(),
      idempotencyKey: randomUUID(),
      requestHash: 'a'.repeat(64),
    });
  const first = await publish();
  expect(first.version.checksum).toMatch(/^wf:sha256:v2:[a-f0-9]{64}$/u);
  const legacy = JSON.parse(
    await readFile(
      new URL(
        '../../fixtures/legacy-workflow-executable.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { checksum: string; envelope: unknown };
  await queryAsOwner(
    'update app.workflow_versions set checksum=$2, executable_json=$3::json where id=$1',
    [first.version.id, legacy.checksum, JSON.stringify(legacy.envelope)],
    workspaceId,
  );
  const upgraded = await publish();
  expect(upgraded.reused).toBe(false);
  expect(upgraded.version.id).not.toBe(first.version.id);
  const unchanged = await publish();
  expect(unchanged.reused).toBe(true);
  expect(unchanged.version.id).toBe(upgraded.version.id);
  const run = async (version: typeof upgraded.version) => {
    const rows = await queryAsOwner(
      'select executable_json,checksum from app.workflow_versions where id=$1',
      [version.id],
      workspaceId,
    );
    return executeNodeAttempt({
      executable: verifyWorkflowExecutable({
        envelope: rows[0]?.executable_json,
        checksum: rows[0]?.checksum,
        catalog: composeExecutableCatalog(CORE_NODE_CATALOG),
      }),
      runId: randomUUID(),
      nodeRunId: randomUUID(),
      attemptId: randomUUID(),
      workflowVersionId: version.id,
      nodeId: 'set',
      invocationKey: invocationKey({
        workflowVersionId: version.id,
        nodeId: 'set',
      }),
      runInput: {},
      completedNodeOutputs: [
        {
          nodeId: 'manual',
          invocationKey: invocationKey({
            workflowVersionId: version.id,
            nodeId: 'manual',
          }),
          value: {},
        },
      ],
      registry: createCoreNodeRegistry(),
      signal: new AbortController().signal,
    });
  };
  expect(JSON.stringify((await run(first.version)).output)).toBe(
    '{"name":"Ada","qty":2}',
  );
  expect(JSON.stringify((await run(upgraded.version)).output)).toBe(
    '{"name":"Ada","qty":2}',
  );
  const save = async (graphJson: unknown) => {
    const draft = await authoring.getDraft(
      workspaceId,
      created.workflowId,
      actorId,
    );
    if (draft === null) throw new Error('Missing draft');
    await authoring.saveDraft({
      ...scope,
      graphJson,
      expectedRevision: draft.revision,
      representationTag: await tag(),
    });
  };
  await save({
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === 'set' ? { ...node, inputMappings: { qty, name } } : node,
    ),
  });
  const reordered = await publish();
  expect(reordered.reused).toBe(false);
  expect(reordered.version.checksum).not.toBe(upgraded.version.checksum);
  expect(JSON.stringify((await run(reordered.version)).output)).toBe(
    '{"qty":2,"name":"Ada"}',
  );
  const draft = await authoring.getDraft(
    workspaceId,
    created.workflowId,
    actorId,
  );
  if (draft === null) throw new Error('Missing draft');
  await save({
    ...draft.graphJson,
    notes: [
      {
        id: randomUUID(),
        text: 'Documentation',
        position: { x: 0, y: 0 },
        size: { width: 320, height: 200 },
        color: 'violet',
      },
    ],
  });
  const documented = await publish();
  expect(documented.reused).toBe(false);
  expect(documented.version.id).not.toBe(reordered.version.id);
  expect(documented.version.checksum).toBe(reordered.version.checksum);
  expect(documented.version.graphJson.notes?.[0]?.text).toBe('Documentation');
});
