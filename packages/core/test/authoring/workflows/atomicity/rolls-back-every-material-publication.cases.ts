import { expect, it } from 'vitest';
import {
  CONNECTION_AUTH_TYPE,
  actorId,
  apiPool,
  apiUrl,
  authoring,
  createHash,
  createWorkflowAuthoringDatabase,
  createConnectionStore,
  currentRepresentationTag,
  saveCurrentDraft,
  draftNode,
  emptyGraph,
  failAtWrite,
  finishTransactionClient,
  parseDatabaseConfig,
  publicationWrite,
  randomUUID,
  workspaceId,
  queryAsOwner,
} from '../../../support/workflow-authoring.js';
import { publicationFacts } from './fixture.js';

export function registerRollsBackEveryMaterialPublication(): void {
  it('rolls back every material publication step and locked-validator failure', async () => {
    const steps = [
      'version',
      'integration_usage',
      'trigger_projection',
      'pointer',
      'outbox',
      'audit',
      'idempotency',
    ] as const;
    const connectionId = randomUUID();
    const connectionDatabase = createConnectionStore(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
    );
    const rollbackCatalog = Object.freeze({
      definitions: Object.freeze([
        Object.freeze({ key: 'core.webhook', version: 1 }),
        Object.freeze({
          key: 'test.placeholder',
          version: 1,
          integration: Object.freeze({
            providerKey: 'http',
            operationKey: 'request',
            connectionSlots: Object.freeze(['primary']),
          }),
        }),
      ]),
    });
    const rollbackAuthoring = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      { definitionCatalog: rollbackCatalog },
    );
    const rollbackGraph = {
      ...emptyGraph,
      nodes: [
        {
          id: 'webhook',
          definition: { key: 'core.webhook', version: 1 },
          position: { x: 0, y: 0 },
          configVersion: 1,
          config: {},
          inputMappings: {},
          connectionRefs: {},
        },
        {
          ...draftNode('integration'),
          connectionRefs: { primary: connectionId },
        },
      ],
    };
    try {
      await connectionDatabase.createConnection({
        workspaceId,
        actorId,
        connectionId,
        secretVersionId: randomUUID(),
        providerKey: 'http',
        name: `Atomicity ${connectionId.slice(0, 8)}`,
        authType: CONNECTION_AUTH_TYPE.httpHeaders,
        sealed: {
          kmsKeyReference: 'arn:aws:kms:region:account:key/atomicity',
          encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
          ciphertext: Buffer.from('atomicity').toString('base64url'),
          nonce: Buffer.alloc(12, 2).toString('base64url'),
          tag: Buffer.alloc(16, 3).toString('base64url'),
        },
        idempotencyKey: `atomicity-${connectionId}`,
        requestHash: createHash('sha256').update(connectionId).digest('hex'),
      });
      for (const step of steps) {
        const created = await rollbackAuthoring.createWorkflow({
          actorId,
          emptyGraph: rollbackGraph,
          idempotencyKey: `create-rollback-${step}`,
          name: `Rollback ${step}`,
          workspaceId,
        });
        const fault = await failAtWrite(
          publicationWrite(step, created.workflowId),
        );
        try {
          const representationTag = await currentRepresentationTag(
            rollbackAuthoring,
            workspaceId,
            {
              scopedWorkflowId: created.workflowId,
              scopedActorId: actorId,
              definitionCatalog: rollbackCatalog,
            },
          );
          await expect(
            rollbackAuthoring.publishWorkflow({
              actorId,
              representationTag,
              idempotencyKey: `publish-rollback-${step}`,
              requestHash: createHash('sha256').update(step).digest('hex'),
              workflowId: created.workflowId,
              workspaceId,
            }),
          ).rejects.toThrow(fault.message);
        } finally {
          await fault.remove();
        }
        const proof = await apiPool.connect();
        let proofOpen = false;
        let proofError: unknown;
        try {
          await proof.query('begin');
          proofOpen = true;
          await proof.query("select set_config('app.workspace_id', $1, true)", [
            workspaceId,
          ]);
          const rows = await proof.query<{
            audits: string;
            commands: string;
            outbox: string;
            pointer: string | null;
            usage: string;
            triggers: string;
            versions: string;
          }>(
            `select
            (select count(*) from app.workflow_versions where workflow_id = $1)::text versions,
            (select count(*) from app.audit_events where target_id = $1 and action = 'workflow.published')::text audits,
            (select count(*) from app.outbox_events where aggregate_id = $1 and job_name = 'reconcile-workflow-triggers')::text outbox,
            (select count(*) from app.idempotency_records where resource_id = $1 and operation = 'workflow.publish')::text commands,
            (select count(*) from app.workflow_integration_usage usage join app.workflow_versions version on version.id = usage.workflow_version_id where version.workflow_id = $1)::text usage,
            (select count(*) from app.workflow_triggers trigger where trigger.workflow_id = $1)::text triggers,
            (select published_version_id::text from app.workflows where id = $1) pointer`,
            [created.workflowId],
          );
          expect(rows.rows[0]).toEqual({
            audits: '0',
            commands: '0',
            outbox: '0',
            pointer: null,
            usage: '0',
            triggers: '0',
            versions: '0',
          });
          await proof.query('rollback');
          proofOpen = false;
        } catch (error: unknown) {
          proofError = error;
        }
        await finishTransactionClient(proof, {
          label: `Publication ${step} rollback proof`,
          primaryError: proofError,
          transactionOpen: proofOpen,
        });
      }
      const reused = await rollbackAuthoring.createWorkflow({
        actorId,
        emptyGraph: rollbackGraph,
        idempotencyKey: 'create-reused-projection-rollback',
        name: 'Reused projection rollback',
        workspaceId,
      });
      const first = await rollbackAuthoring.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          rollbackAuthoring,
          workspaceId,
          {
            scopedWorkflowId: reused.workflowId,
            scopedActorId: actorId,
            definitionCatalog: rollbackCatalog,
          },
        ),
        idempotencyKey: 'publish-reused-projection-baseline',
        requestHash: 'a'.repeat(64),
        workflowId: reused.workflowId,
        workspaceId,
      });
      const beforeRebuild = await publicationFacts(reused.workflowId);
      for (const [index, step] of (
        ['integration_usage', 'trigger_projection'] as const
      ).entries()) {
        await saveCurrentDraft(rollbackAuthoring, {
          actorId,
          expectedRevision: index + 1,
          graphJson: {
            ...rollbackGraph,
            nodes: rollbackGraph.nodes.map((node) => ({
              ...node,
              label: `Presentation ${String(index)}`,
            })),
          },
          workflowId: reused.workflowId,
          workspaceId,
        });
        const fault = await failAtWrite(
          publicationWrite(step, reused.workflowId),
        );
        try {
          await expect(
            rollbackAuthoring.publishWorkflow({
              actorId,
              representationTag: await currentRepresentationTag(
                rollbackAuthoring,
                workspaceId,
                {
                  scopedWorkflowId: reused.workflowId,
                  scopedActorId: actorId,
                  definitionCatalog: rollbackCatalog,
                },
              ),
              idempotencyKey: `publish-reused-projection-${step}`,
              requestHash: createHash('sha256').update(step).digest('hex'),
              workflowId: reused.workflowId,
              workspaceId,
            }),
          ).rejects.toThrow(fault.message);
        } finally {
          await fault.remove();
        }
        expect(await publicationFacts(reused.workflowId)).toEqual(
          beforeRebuild,
        );
      }
      expect(beforeRebuild).toMatchObject({
        pointer: first.version.id,
        audits: 1,
        commands: 1,
        outbox: 1,
      });
    } finally {
      await Promise.all([
        connectionDatabase.close(),
        rollbackAuthoring.close(),
      ]);
    }

    const invalid = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-validator-failure',
      name: 'Validator failure',
      workspaceId,
    });
    await saveCurrentDraft(authoring, {
      actorId,
      expectedRevision: 1,
      graphJson: { ...emptyGraph, nodes: [draftNode('unknown-definition')] },
      workflowId: invalid.workflowId,
      workspaceId,
    });
    await expect(
      authoring.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          authoring,
          workspaceId,
          { scopedWorkflowId: invalid.workflowId, scopedActorId: actorId },
        ),
        idempotencyKey: 'publish-validator-failure',
        requestHash: '8'.repeat(64),
        workflowId: invalid.workflowId,
        workspaceId,
      }),
    ).rejects.toThrow('workflow graph failed semantic validation');
    await expect(
      queryAsOwner<{
        audits: number;
        commands: number;
        outbox: number;
        pointer: string | null;
        versions: number;
      }>(
        `select workflow.published_version_id::text pointer,
                (select count(*)::int from app.workflow_versions
                  where workflow_id=workflow.id) versions,
                (select count(*)::int from app.audit_events
                  where target_id=workflow.id and action='workflow.published') audits,
                (select count(*)::int from app.outbox_events
                  where aggregate_id=workflow.id) outbox,
                (select count(*)::int from app.idempotency_records
                  where resource_id=workflow.id and operation='workflow.publish') commands
           from app.workflows workflow where workflow.id=$1`,
        [invalid.workflowId],
        workspaceId,
      ),
    ).resolves.toEqual([
      { audits: 0, commands: 0, outbox: 0, pointer: null, versions: 0 },
    ]);
  });
}
