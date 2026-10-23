import { expect, it } from 'vitest';
import {
  WorkflowNotFoundError,
  CONNECTION_AUTH_TYPE,
  actorId,
  apiUrl,
  enforceTestRetention,
  authoring,
  createWorkflowAuthoringDatabase,
  createConnectionDatabase,
  createHash,
  draftNode,
  emptyGraph,
  otherActorId,
  otherWorkspaceId,
  parseDatabaseConfig,
  queryAsOwner,
  randomUUID,
  workspaceId,
} from '../../../support/workflow-authoring.js';
import { source, command, facts, commandFacts } from './fixture.js';

export function registerRetainsSameWorkspaceConnectionReferences(): void {
  it('retains same-workspace connection references without reading or duplicating secrets and rejects foreign refs in arbitrary slots', async () => {
    const connections = createConnectionDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
    );
    const database = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      {
        definitionCatalog: {
          definitions: [
            { key: 'test.placeholder', version: 1 },
            { key: 'core.foreach', version: 1 },
          ],
        },
      },
    );
    const connectionId = randomUUID(),
      foreignId = randomUUID();
    const create = async (id: string, workspace: string, actor: string) =>
      connections.createConnection({
        workspaceId: workspace,
        actorId: actor,
        connectionId: id,
        secretVersionId: randomUUID(),
        providerKey: 'http',
        name: 'Reference only',
        authType: CONNECTION_AUTH_TYPE.httpHeaders,
        idempotencyKey: randomUUID(),
        requestHash: createHash('sha256').update(id).digest('hex'),
        sealed: {
          kmsKeyReference: 'arn:aws:kms:region:account:key/duplication',
          encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
          ciphertext: Buffer.from('never-copy-secret').toString('base64url'),
          nonce: Buffer.alloc(12, 2).toString('base64url'),
          tag: Buffer.alloc(16, 3).toString('base64url'),
        },
      });
    try {
      await create(connectionId, workspaceId, actorId);
      await create(foreignId, otherWorkspaceId, otherActorId);
      const graph = {
        ...emptyGraph,
        nodes: [
          { ...draftNode('ref'), connectionRefs: { arbitrary: connectionId } },
        ],
      };
      const original = await source(database, graph);
      const input = await command(original.workflowId, database);
      const secrets = await queryAsOwner(
        'select id,ciphertext from app.connection_secret_versions order by id',
        [],
        workspaceId,
      );
      expect(secrets).toHaveLength(1);
      const copied = await database.duplicateWorkflow(input);
      expect((await facts(copied.workflowId)).graph).toEqual(graph);
      expect(
        await queryAsOwner(
          'select id,ciphertext from app.connection_secret_versions order by id',
          [],
          workspaceId,
        ),
      ).toEqual(secrets);
      await connections.revokeConnection({
        actorId,
        workspaceId,
        connectionId,
      });
      const revokedCopy = await database.duplicateWorkflow({
        ...input,
        idempotencyKey: randomUUID(),
      });
      expect((await facts(revokedCopy.workflowId)).graph).toEqual(graph);
      expect(
        await queryAsOwner(
          'select status from app.connections where id=$1',
          [connectionId],
          workspaceId,
        ),
      ).toEqual([{ status: 'revoked' }]);
      // A forged persisted reference is an owner-controlled corruption fixture, not client graph admission.
      await queryAsOwner(
        'update app.workflow_drafts set graph_json=$2 where workflow_id=$1',
        [
          original.workflowId,
          JSON.stringify({
            ...graph,
            nodes: [
              {
                ...draftNode('ref'),
                connectionRefs: { arbitrary: foreignId },
              },
            ],
          }),
        ],
        workspaceId,
      );
      const foreign = await command(original.workflowId, database);
      const before = await commandFacts();
      await expect(database.duplicateWorkflow(foreign)).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
      expect(await commandFacts()).toEqual(before);
      const nestedForeign = {
        ...emptyGraph,
        nodes: [
          {
            ...draftNode('loop-ref'),
            definition: { key: 'core.foreach', version: 1 },
            structured: {
              kind: 'for_each',
              maxIterations: 10,
              maxConcurrency: 1,
              body: {
                ...emptyGraph,
                inputPorts: ['item', 'ordinal'],
                outputPorts: ['result'],
                nodes: [
                  {
                    ...draftNode('nested-ref'),
                    connectionRefs: { arbitrary: foreignId },
                  },
                ],
              },
            },
          },
        ],
      };
      await queryAsOwner(
        'update app.workflow_drafts set graph_json=$2 where workflow_id=$1',
        [original.workflowId, JSON.stringify(nestedForeign)],
        workspaceId,
      );
      await expect(
        database.duplicateWorkflow(
          await command(original.workflowId, database),
        ),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
      expect(await commandFacts()).toEqual(before);
      expect(await database.duplicateWorkflow(input)).toEqual(copied);
    } finally {
      await Promise.all([database.close(), connections.close()]);
    }
  });

  it('copies a template origin as inherited and shows it only to members of the workspace', async () => {
    const original = await source();
    const origin = {
      templateId: 'controlled-http-notification',
      templateVersion: 1,
      baseManifestDigest: 'a'.repeat(64),
      creationCommandDigest: 'b'.repeat(64),
      derivation: 'direct',
    };
    await queryAsOwner(
      'insert into app.workflow_template_origins (workspace_id, workflow_id, origin) values ($1, $2, $3::jsonb)',
      [workspaceId, original.workflowId, JSON.stringify(origin)],
      workspaceId,
    );
    const input = await command(original.workflowId);
    const copy = await authoring.duplicateWorkflow(input);
    expect(await authoring.duplicateWorkflow(input)).toEqual(copy);
    expect(
      await authoring.getWorkflowWithTemplateOrigin(
        workspaceId,
        copy.workflowId,
        actorId,
      ),
    ).toMatchObject({ templateOrigin: { ...origin, derivation: 'inherited' } });
    expect(
      await authoring.getWorkflowWithTemplateOrigin(
        workspaceId,
        original.workflowId,
        actorId,
      ),
    ).toMatchObject({ templateOrigin: origin });
    const copyOfCopy = await authoring.duplicateWorkflow(
      await command(copy.workflowId),
    );
    expect(
      await authoring.getWorkflowWithTemplateOrigin(
        workspaceId,
        copyOfCopy.workflowId,
        actorId,
      ),
    ).toMatchObject({ templateOrigin: { ...origin, derivation: 'inherited' } });
    await expect(
      authoring.getWorkflowWithTemplateOrigin(
        workspaceId,
        copy.workflowId,
        otherActorId,
      ),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it('removes an expired duplicate receipt without erasing either workflow and admits a new copy after expiry', async () => {
    const original = await source();
    const input = await command(original.workflowId);
    const copied = await authoring.duplicateWorkflow(input);
    await queryAsOwner(
      "update app.idempotency_records set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and operation='workflow.duplicate' and resource_id=$2",
      [workspaceId, copied.workflowId],
      workspaceId,
    );
    const reaped = await enforceTestRetention();
    expect(reaped.idempotency_records).toBeGreaterThanOrEqual(1);
    expect((await facts(original.workflowId)).revision).toBe(1);
    expect((await facts(copied.workflowId)).revision).toBe(1);
    expect((await facts(copied.workflowId)).receipts).toBe(0);
    const afterExpiry = await authoring.duplicateWorkflow(input);
    expect(afterExpiry.workflowId).not.toBe(copied.workflowId);
  });
}
