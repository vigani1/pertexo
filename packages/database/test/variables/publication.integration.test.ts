import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  InvalidWorkflowGraphError,
  type ValueSource,
} from '@pertexo/workflow-model';
import { AuthoringValidationUnavailableError } from '@pertexo/workflow-model/server';
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
import { waitForApplicationLock } from '../support/postgres/lock-coordination.js';
import { adminDatabaseUrl } from '../support/workflow-authoring/base.js';
const publishingApplication = `variable-publication-${randomUUID()}`;
let authoring: ReturnType<typeof createWorkflowAuthoringDatabase>;
let publishing: ReturnType<typeof createWorkflowAuthoringDatabase>;
let admin: Pool;
beforeAll(() => {
  admin = new Pool({ connectionString: adminDatabaseUrl, max: 2 });
  const config = parseDatabaseConfig({ connectionString: apiUrl, max: 3 });
  authoring = createWorkflowAuthoringDatabase(config, {
    definitionCatalog: testDefinitionCatalog,
  });
  const named = new URL(apiUrl);
  named.searchParams.set('application_name', publishingApplication);
  publishing = createWorkflowAuthoringDatabase(
    parseDatabaseConfig({ connectionString: named.toString(), max: 1 }),
    { definitionCatalog: testDefinitionCatalog },
  );
});
afterAll(async () => {
  await Promise.all([authoring.close(), publishing.close(), admin.end()]);
});
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

/** A busy machine's validator asks for a retry; the lock wait has already happened. */
async function publishedOnceValidatorAnswers(
  publish: () => Promise<unknown>,
): Promise<boolean> {
  for (let tries = 1; ; tries += 1) {
    try {
      await publish();
      return true;
    } catch (error: unknown) {
      if (error instanceof InvalidWorkflowGraphError) return false;
      if (
        !(error instanceof AuthoringValidationUnavailableError) ||
        tries === 5
      )
        throw error;
      await delay(1_000);
    }
  }
}

it.each([
  ['commits, the publication is checked against the new set', 'commit', false],
  [
    'rolls back, the publication is checked against the old set',
    'rollback',
    true,
  ],
] as const)(
  'waits for an open edit to the set: when it %s',
  async (_case, finish, published) => {
    await setVariableSet(workspaceId, { RATE: 10 });
    const created = await authoring.createWorkflow({
      workspaceId,
      actorId,
      name: 'Publication during an edit',
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
          {
            ...draftNode('calculate'),
            inputMappings: {
              result: { kind: 'workspace_variable', name: 'RATE' },
            },
          },
        ],
      },
    });
    const representationTag = await currentRepresentationTag(
      authoring,
      workspaceId,
      { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
    );
    const writer = await admin.connect();
    try {
      await writer.query('begin');
      await writer.query(
        `with next_set as (
           insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json)
           select $1,max(revision)+1,'{"OTHER":1}'::jsonb
             from app.workspace_variable_set_revisions where workspace_id=$1
           returning revision
         )
         update app.workspace_variables head set revision=next_set.revision
           from next_set where head.workspace_id=$1`,
        [workspaceId],
      );
      const publish = () =>
        publishing.publishWorkflow({
          workspaceId,
          actorId,
          workflowId: created.workflowId,
          representationTag,
          idempotencyKey: randomUUID(),
          requestHash: createHash('sha256')
            .update(representationTag)
            .digest('hex'),
        });
      const pending = publishedOnceValidatorAnswers(publish);
      await waitForApplicationLock(admin, publishingApplication);
      await writer.query(finish);
      expect(await pending).toBe(published);
    } finally {
      await writer.query('rollback');
      writer.release();
    }
  },
);
