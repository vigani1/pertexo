import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import { afterAll, expect, it } from 'vitest';
import {
  actorId,
  apiUrl,
  createWorkflowAuthoringStore,
  parseDatabaseConfig,
  currentRepresentationTag,
  draftNode,
  randomUUID,
  workspaceId,
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
      definitions: ['core.manual', 'core.condition', 'core.set'].map((key) => ({
        key,
        version: 1,
      })),
    },
  },
);
afterAll(() => authoring.close());

it('reports the same step scope issue while validating and publishing, before a run can be admitted', async () => {
  const step = (id: string, key: string) => ({
    ...draftNode(id),
    config: {},
    definition: { key, version: 1 },
    inputMappings:
      key === 'core.condition'
        ? { condition: { kind: 'literal', value: true } }
        : {},
  });
  const nodes = [
    step('manual', 'core.manual'),
    ...Array.from({ length: 7 }, () => step(randomUUID(), 'core.condition')),
    step('leaf', 'core.set'),
  ];
  const graph = {
    settings: {},
    nodes,
    edges: nodes.slice(1).map((node, n) => ({
      id: `edge-${String(n)}`,
      source: { nodeId: nodes[n]?.id ?? '', port: n === 0 ? 'out' : 'true' },
      target: { nodeId: node.id, port: 'in' },
    })),
  };
  const created = await authoring.createWorkflow({
    actorId,
    workspaceId,
    name: 'Unsupported scope',
    emptyGraph: graph,
    idempotencyKey: randomUUID(),
  });
  const checked = await authoring.validateDraft(
    workspaceId,
    created.workflowId,
    actorId,
  );
  expect(checked?.validation.ok).toBe(false);
  expect(checked?.validation.issues).toHaveLength(1);
  const issue = checked?.validation.issues[0];
  expect(issue?.code).toBe('graph_limit');
  expect(issue?.path).toMatch(/^\$\.nodes\./u);
  expect(issue?.message).toContain('256-character execution identity limit');
  await expect(
    authoring.publishWorkflow({
      actorId,
      workspaceId,
      workflowId: created.workflowId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
      ),
      idempotencyKey: randomUUID(),
      requestHash: 'a'.repeat(64),
    }),
  ).rejects.toMatchObject({
    name: 'InvalidWorkflowGraphError',
    issues: checked?.validation.issues,
  });
});
