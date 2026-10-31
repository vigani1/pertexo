import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  InvalidWorkflowGraphError,
  type ValueSource,
} from '@pertexo/workflow-model';
import {
  actorId,
  workspaceId,
  apiUrl,
  parseDatabaseConfig,
  randomUUID,
  createHash,
  createWorkflowAuthoringDatabase,
  testDefinitionCatalog,
  emptyGraph,
  draftNode,
  saveCurrentDraft,
  currentRepresentationTag,
} from '../support/workflow-authoring.js';
import { setVariableSet } from '../support/variable-sets.js';
let authoring: ReturnType<typeof createWorkflowAuthoringDatabase>;
beforeAll(() => {
  const config = parseDatabaseConfig({ connectionString: apiUrl, max: 3 });
  authoring = createWorkflowAuthoringDatabase(config, {
    definitionCatalog: testDefinitionCatalog,
  });
});
afterAll(() => authoring.close());
it.each([
  { kind: 'workspace_variable' as const, name: 'RATE' },
  {
    kind: 'expression' as const,
    language: 'jsonata' as const,
    expression: '$vars.RATE * 2',
  },
])(
  'checks current names at publication, while exact receipts keep their accepted result: %j',
  async (source: ValueSource) => {
    const configure = (values: Record<string, number>) =>
      setVariableSet(workspaceId, values);
    await configure({});
    const created = await authoring.createWorkflow({
      workspaceId,
      actorId,
      name: 'Publication configuration',
      emptyGraph,
      idempotencyKey: randomUUID(),
    });
    await saveCurrentDraft(authoring, {
      workspaceId,
      actorId,
      workflowId: created.workflowId,
      expectedRevision: 1,
      graphJson: {
        ...emptyGraph,
        nodes: [
          { ...draftNode('calculate'), inputMappings: { result: source } },
        ],
      },
    });
    const representationTag = await currentRepresentationTag(
      authoring,
      workspaceId,
      { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
    );
    const command = {
      workspaceId,
      actorId,
      workflowId: created.workflowId,
      representationTag,
      idempotencyKey: randomUUID(),
      requestHash: createHash('sha256').update(representationTag).digest('hex'),
    };
    await expect(authoring.publishWorkflow(command)).rejects.toBeInstanceOf(
      InvalidWorkflowGraphError,
    );
    expect(
      (await authoring.getWorkflow(workspaceId, created.workflowId, actorId))
        ?.publishedVersionId,
    ).toBeNull();
    await configure({ RATE: 10 });
    const accepted = await authoring.publishWorkflow(command);
    expect(accepted.replayed).toBe(false);
    await configure({});
    expect(await authoring.publishWorkflow(command)).toMatchObject({
      replayed: true,
      version: { id: accepted.version.id },
    });
    await expect(
      authoring.publishWorkflow({ ...command, idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(InvalidWorkflowGraphError);
  },
);
