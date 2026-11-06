import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import { afterAll, expect, it } from 'vitest';
import { approvalConfigSchema } from '@pertexo/workflow-model';
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
      definitions: [
        'core.manual',
        'core.terminate',
        'core.approval',
        'core.call',
      ].map((key) => ({ key, version: 1 })),
    },
  },
);
afterAll(() => authoring.close());

it.each(['task audience', 'Call dependency'] as const)(
  'publishes a draft whose current %s check passed',
  async (kind) => {
    const child = await authoring.createWorkflow({
      actorId,
      workspaceId,
      name: 'Checked callable target',
      idempotencyKey: randomUUID(),
      emptyGraph: {
        ...emptyGraph,
        nodes: ['core.manual', 'core.terminate'].map((key, index) => ({
          ...draftNode(`child-${String(index)}`),
          definition: { key, version: 1 },
          config: {},
        })),
        callable: {
          input: { type: 'string' },
          resultType: { type: 'string' },
          result: { kind: 'run_input', path: '$' },
        },
      },
    });
    const target = await authoring.publishWorkflow({
      actorId,
      workspaceId,
      workflowId: child.workflowId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        {
          scopedWorkflowId: child.workflowId,
          scopedActorId: actorId,
        },
      ),
      idempotencyKey: randomUUID(),
      requestHash: 'a'.repeat(64),
    });
    const graph = {
      ...emptyGraph,
      nodes: [
        {
          ...draftNode('checked-step'),
          definition: {
            key: kind === 'task audience' ? 'core.approval' : 'core.call',
            version: 1,
          },
          config:
            kind === 'task audience'
              ? approvalConfigSchema.parse({
                  audience: { roles: [], memberIds: [actorId] },
                })
              : {
                  target: {
                    workflowId: child.workflowId,
                    workflowVersionId: target.version.id,
                    executableChecksum: target.version.checksum,
                  },
                },
        },
      ],
    };
    const created = await authoring.createWorkflow({
      actorId,
      workspaceId,
      name: `Checked ${kind}`,
      emptyGraph: graph,
      idempotencyKey: randomUUID(),
    });
    expect(
      (await authoring.validateDraft(workspaceId, created.workflowId, actorId))
        ?.validation,
    ).toMatchObject({ ok: true, issues: [] });
    const published = await authoring.publishWorkflow({
      actorId,
      workspaceId,
      workflowId: created.workflowId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        {
          scopedWorkflowId: created.workflowId,
          scopedActorId: actorId,
        },
      ),
      idempotencyKey: randomUUID(),
      requestHash: 'a'.repeat(64),
    });
    expect(published.version.graphJson).toEqual(graph);
    expect(published.reused).toBe(false);
  },
);
