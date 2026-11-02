import { expect, it } from 'vitest';
import {
  actorId,
  apiUrl,
  createWorkflowAuthoringStore,
  currentRepresentationTag,
  draftNode,
  emptyGraph,
  parseDatabaseConfig,
  randomUUID,
  saveCurrentDraft,
  workspaceId,
} from '../../../support/workflow-authoring.js';
import { source, command, facts, commandFacts } from './fixture.js';
import { WorkflowDefinitionPlacementError } from '../../../../src/authoring/workflows/errors.js';

export function registerReplaysCompletedCommandBeforeCatalog(): void {
  it('replays a completed command before catalog admission while new copies cannot grandfather removed definitions', async () => {
    const current = createWorkflowAuthoringStore(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      {
        definitionCatalog: {
          definitions: [{ key: 'test.placeholder', version: 1 }],
        },
      },
    );
    const removed = createWorkflowAuthoringStore(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      {
        definitionCatalog: { definitions: [] },
      },
    );
    try {
      const original = await source(current, {
        ...emptyGraph,
        nodes: [draftNode('retained-id')],
      });
      const input = await command(original.workflowId, current);
      const copied = await current.duplicateWorkflow(input);
      expect(await removed.duplicateWorkflow(input)).toEqual(copied);
      const before = await commandFacts();
      await expect(
        removed.duplicateWorkflow({
          ...input,
          idempotencyKey: randomUUID(),
          representationTag: await currentRepresentationTag(
            removed,
            workspaceId,
            { scopedWorkflowId: original.workflowId, scopedActorId: actorId },
          ),
        }),
      ).rejects.toBeInstanceOf(WorkflowDefinitionPlacementError);
      expect(await commandFacts()).toEqual(before);
    } finally {
      await Promise.all([current.close(), removed.close()]);
    }
  });

  it('preserves nested graph IDs, typed mappings, merge references and dynamic expressions as exact JSON content', async () => {
    const catalog = {
      definitions: [
        { key: 'test.placeholder', version: 1 },
        { key: 'core.foreach', version: 1 },
        { key: 'core.parallel', version: 1 },
        { key: 'core.merge', version: 1 },
      ],
    };
    const database = createWorkflowAuthoringStore(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      {
        definitionCatalog: catalog,
      },
    );
    const graph = {
      ...emptyGraph,
      settings: { maxRunDurationMs: 1000 },
      nodes: [
        {
          ...draftNode('producer'),
          label: 'Literal producer',
          disabled: true,
          config: { literal: 'producer' },
        },
        {
          ...draftNode('loop'),
          definition: { key: 'core.foreach', version: 1 },
          structured: {
            kind: 'for_each',
            maxIterations: 10,
            maxConcurrency: 2,
            body: {
              ...emptyGraph,
              inputPorts: ['item', 'ordinal'],
              outputPorts: ['result'],
              nodes: [
                {
                  ...draftNode('nested'),
                  inputMappings: {
                    value: {
                      kind: 'structured_input',
                      port: 'item',
                      path: '$',
                    },
                  },
                },
              ],
            },
          },
        },
        {
          ...draftNode('parallel'),
          definition: { key: 'core.parallel', version: 1 },
          config: { branches: ['left', 'right'] },
        },
        {
          ...draftNode('merge'),
          definition: { key: 'core.merge', version: 1 },
          config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
          inputMappings: {
            dynamic: {
              kind: 'expression',
              language: 'jsonata',
              expression: '$lookup(nodeOutputs, runInput.stepId).value',
            },
            typed: { kind: 'node_output', nodeId: 'producer', path: '$.value' },
          },
        },
      ],
      edges: [
        {
          id: 'parallel-merge',
          source: { nodeId: 'parallel', port: 'left' },
          target: { nodeId: 'merge', port: 'in' },
        },
      ],
    };
    try {
      const original = await source(database, graph);
      const input = await command(original.workflowId, database);
      const copied = await database.duplicateWorkflow(input);
      expect((await facts(copied.workflowId)).graph).toEqual(graph);
      expect((await facts(original.workflowId)).graph).toEqual(graph);
      await saveCurrentDraft(database, {
        actorId,
        workspaceId,
        workflowId: copied.workflowId,
        expectedRevision: 1,
        graphJson: { ...graph, settings: { maxRunDurationMs: 2000 } },
      });
      expect((await facts(original.workflowId)).graph).toEqual(graph);
      expect((await facts(copied.workflowId)).revision).toBe(2);
    } finally {
      await database.close();
    }
  });

  it('publishes and edits source and copy independently even when every graph ID is shared', async () => {
    const database = createWorkflowAuthoringStore(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      {
        definitionCatalog: {
          definitions: [{ key: 'test.placeholder', version: 1 }],
        },
      },
    );
    const graph = {
      ...emptyGraph,
      nodes: [draftNode('same-id', { value: 'source' })],
    };
    try {
      const original = await source(database, graph);
      const copied = await database.duplicateWorkflow(
        await command(original.workflowId, database),
      );
      const publish = async (workflowId: string) =>
        database.publishWorkflow({
          actorId,
          workspaceId,
          workflowId,
          representationTag: await currentRepresentationTag(
            database,
            workspaceId,
            { scopedWorkflowId: workflowId, scopedActorId: actorId },
          ),
          idempotencyKey: randomUUID(),
          requestHash: 'c'.repeat(64),
        });
      const publications = await Promise.all([
        publish(original.workflowId),
        publish(copied.workflowId),
      ]);
      expect(publications[0].version.id).not.toBe(publications[1].version.id);
      await saveCurrentDraft(database, {
        actorId,
        workspaceId,
        workflowId: copied.workflowId,
        expectedRevision: 1,
        graphJson: {
          ...graph,
          nodes: [draftNode('same-id', { value: 'copy-only' })],
        },
      });
      const next = await publish(copied.workflowId);
      expect(next.version.versionNumber).toBe(2);
      expect((await facts(original.workflowId)).graph).toEqual(graph);
      expect((await facts(original.workflowId)).versions).toBe(1);
      expect((await facts(copied.workflowId)).versions).toBe(2);
    } finally {
      await database.close();
    }
  });
}
