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
      definitions: ['core.manual', 'core.set'].map((key) => ({
        key,
        version: 1,
      })),
    },
  },
);
afterAll(() => authoring.close());

it.each([100, 101])(
  'validates and publishes consistently at %i direct predecessors',
  async (count) => {
    const step = (id: string, key = 'core.set') => ({
      ...draftNode(id),
      config: {},
      definition: { key, version: 1 },
      inputMappings: {},
    });
    const sources = Array.from({ length: count }, (_, n) =>
      step(`source-${String(n)}`),
    );
    const graph = {
      settings: {},
      nodes: [step('manual', 'core.manual'), ...sources, step('sink')],
      edges: sources.flatMap((source) => [
        {
          id: `start-${source.id}`,
          source: { nodeId: 'manual', port: 'out' },
          target: { nodeId: source.id, port: 'in' },
        },
        {
          id: `end-${source.id}`,
          source: { nodeId: source.id, port: 'out' },
          target: { nodeId: 'sink', port: 'in' },
        },
      ]),
    };
    const created = await authoring.createWorkflow({
      actorId,
      workspaceId,
      name: 'Fan-in capacity',
      emptyGraph: graph,
      idempotencyKey: randomUUID(),
    });
    const checked = await authoring.validateDraft(
      workspaceId,
      created.workflowId,
      actorId,
    );
    expect(checked?.validation.ok).toBe(count === 100);
    const publishing = authoring.publishWorkflow({
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
    });
    if (count === 100) {
      await expect(publishing).resolves.toMatchObject({
        version: { versionNumber: 1 },
      });
    } else {
      expect(checked?.validation.issues).toEqual([
        {
          code: 'graph_limit',
          path: '$.nodes.sink',
          message:
            'A step can have at most 100 direct predecessors. Add an intermediate step to combine their outputs.',
        },
      ]);
      await expect(publishing).rejects.toMatchObject({
        name: 'InvalidWorkflowGraphError',
        issues: checked?.validation.issues,
      });
    }
  },
);
