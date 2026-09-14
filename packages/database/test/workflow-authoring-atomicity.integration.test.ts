import { describe, expect, it } from 'vitest';

import {
  CONNECTION_AUTH_TYPE,
  WorkflowIdempotencyConflictError,
  actorId,
  apiPool,
  apiUrl,
  authoring,
  createHash,
  createWorkflowAuthoringDatabase,
  createConnectionDatabase,
  currentRepresentationTag,
  saveCurrentDraft,
  draftNode,
  emptyGraph,
  finishTransactionClient,
  ownerPool,
  parseDatabaseConfig,
  randomUUID,
  workflowDraftRepresentationTag,
  workflowId,
  workspaceId,
  queryAsOwner,
} from './support/workflow-authoring.integration.support.js';

async function publicationFacts(scopedWorkflowId: string) {
  const rows = await queryAsOwner<{
    audits: number;
    commands: number;
    outbox: number;
    pointer: string | null;
    triggers: unknown;
    usage: unknown;
    versions: unknown;
  }>(
    `select workflow.published_version_id::text pointer,
            (select jsonb_agg(version.id order by version.version_number)
               from app.workflow_versions version
              where version.workflow_id=workflow.id) versions,
            (select jsonb_agg(jsonb_build_object(
                       'connectionId',usage.connection_id,
                       'operationKey',usage.operation_key,
                       'providerKey',usage.provider_key)
                     order by usage.provider_key,usage.operation_key,usage.connection_id)
               from app.workflow_integration_usage usage
               join app.workflow_versions version
                 on version.id=usage.workflow_version_id
              where version.workflow_id=workflow.id) usage,
            (select jsonb_agg(jsonb_build_object(
                       'id',trigger.id,'kind',trigger.kind,
                       'nodeId',trigger.node_id,
                       'fingerprint',trigger.config_fingerprint)
                     order by trigger.node_id)
               from app.workflow_triggers trigger
              where trigger.workflow_id=workflow.id) triggers,
            (select count(*)::int from app.audit_events
              where target_id=workflow.id and action='workflow.published') audits,
            (select count(*)::int from app.outbox_events
              where aggregate_id=workflow.id) outbox,
            (select count(*)::int from app.idempotency_records
              where resource_id=workflow.id and operation='workflow.publish') commands
       from app.workflows workflow where workflow.id=$1`,
    [scopedWorkflowId],
    workspaceId,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('publication facts missing');
  return row;
}

describe('workflow publication atomicity', () => {
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
    const connectionDatabase = createConnectionDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
    );
    const rollbackCatalog = Object.freeze({
      schemaVersion: 1 as const,
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
          schemaVersion: 1,
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
        const faulting = createWorkflowAuthoringDatabase(
          parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
          {
            definitionCatalog: rollbackCatalog,
            testHooks: {
              afterPublishStep: (reached) =>
                reached === step
                  ? Promise.reject(new Error(`injected-${step}`))
                  : Promise.resolve(),
            },
          },
        );
        try {
          const representationTag = await currentRepresentationTag(
            rollbackAuthoring,
            workspaceId,
            created.workflowId,
            actorId,
            rollbackCatalog,
          );
          await expect(
            faulting.publishWorkflow({
              actorId,
              representationTag,
              idempotencyKey: `publish-rollback-${step}`,
              requestHash: createHash('sha256').update(step).digest('hex'),
              workflowId: created.workflowId,
              workspaceId,
            }),
          ).rejects.toThrow(`injected-${step}`);
        } finally {
          await faulting.close();
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
          reused.workflowId,
          actorId,
          rollbackCatalog,
        ),
        idempotencyKey: 'publish-reused-projection-baseline',
        requestHash: 'a'.repeat(64),
        workflowId: reused.workflowId,
        workspaceId,
      });
      const beforeRebuild = await publicationFacts(reused.workflowId);
      for (const [index, step] of [
        'integration_usage',
        'trigger_projection',
      ].entries()) {
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
        const faulting = createWorkflowAuthoringDatabase(
          parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
          {
            definitionCatalog: rollbackCatalog,
            testHooks: {
              afterPublishStep: (reached) =>
                reached === step
                  ? Promise.reject(new Error(`injected-rebuild-${step}`))
                  : Promise.resolve(),
            },
          },
        );
        try {
          await expect(
            faulting.publishWorkflow({
              actorId,
              representationTag: await currentRepresentationTag(
                rollbackAuthoring,
                workspaceId,
                reused.workflowId,
                actorId,
                rollbackCatalog,
              ),
              idempotencyKey: `publish-reused-projection-${step}`,
              requestHash: createHash('sha256').update(step).digest('hex'),
              workflowId: reused.workflowId,
              workspaceId,
            }),
          ).rejects.toThrow(`injected-rebuild-${step}`);
        } finally {
          await faulting.close();
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
          invalid.workflowId,
          actorId,
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

  it('publishes atomically, replays exactly, and rejects changed key reuse', async () => {
    const draft = await authoring.getDraft(workspaceId, workflowId, actorId);
    expect(draft).not.toBeNull();
    if (draft === null) throw new Error('Expected workflow draft');
    const representationTag = workflowDraftRepresentationTag({
      workflowId,
      revision: draft.revision,
      graph: draft.graphJson,
      compatibilityFingerprint: draft.compatibility.fingerprint,
    });
    const input = {
      actorId,
      representationTag,
      idempotencyKey: 'publish-proof',
      requestHash: 'a'.repeat(64),
      workflowId,
      workspaceId,
    } as const;
    await expect(
      authoring.publishWorkflow({
        ...input,
        idempotencyKey: 'publish-rollback',
        requestHash: 'e'.repeat(64),
        traceId: 'x'.repeat(129),
      }),
    ).rejects.toMatchObject({ code: '22001' });

    const publications = await Promise.all([
      authoring.publishWorkflow(input),
      authoring.publishWorkflow(input),
    ]);
    expect(publications.map((result) => result.replayed).sort()).toEqual([
      false,
      true,
    ]);
    const published = publications[0];
    const saved = await saveCurrentDraft(authoring, {
      actorId,
      expectedRevision: draft.revision,
      graphJson: draft.graphJson,
      workflowId,
      workspaceId,
    });
    await expect(authoring.publishWorkflow(input)).resolves.toMatchObject({
      replayed: true,
      version: { id: published.version.id },
    });
    await expect(
      authoring.publishWorkflow({
        ...input,
        idempotencyKey: 'publish-stale-distinct',
        requestHash: '9'.repeat(64),
      }),
    ).rejects.toMatchObject({ currentRevision: saved.revision });
    const currentPublications = await Promise.all([
      authoring.publishWorkflow({
        ...input,
        representationTag: workflowDraftRepresentationTag({
          workflowId,
          revision: saved.revision,
          graph: saved.graphJson,
          compatibilityFingerprint: saved.compatibility.fingerprint,
        }),
        idempotencyKey: 'publish-current-distinct-a',
        requestHash: 'd'.repeat(64),
      }),
      authoring.publishWorkflow({
        ...input,
        representationTag: workflowDraftRepresentationTag({
          workflowId,
          revision: saved.revision,
          graph: saved.graphJson,
          compatibilityFingerprint: saved.compatibility.fingerprint,
        }),
        idempotencyKey: 'publish-current-distinct-b',
        requestHash: 'f'.repeat(64),
      }),
    ]);
    expect(currentPublications).toEqual([
      expect.objectContaining({ replayed: false, reused: true }),
      expect.objectContaining({ replayed: false, reused: true }),
    ]);
    await expect(
      authoring.publishWorkflow({ ...input, requestHash: 'c'.repeat(64) }),
    ).rejects.toBeInstanceOf(WorkflowIdempotencyConflictError);

    const owner = await ownerPool.connect();
    let ownerOpen = false;
    let ownerError: unknown;
    try {
      await owner.query('begin');
      ownerOpen = true;
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await expect(
        owner.query(
          'update app.workflow_versions set version_number = 99 where id = $1',
          [published.version.id],
        ),
      ).rejects.toMatchObject({ code: '55000' });
      await owner.query('rollback');
      ownerOpen = false;
    } catch (error: unknown) {
      ownerError = error;
    }
    await finishTransactionClient(owner, {
      label: 'Workflow-version immutability proof',
      primaryError: ownerError,
      transactionOpen: ownerOpen,
    });

    const api = await apiPool.connect();
    let apiOpen = false;
    let apiError: unknown;
    try {
      await api.query('begin');
      apiOpen = true;
      await api.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      const facts = await api.query<{
        audits: string;
        outbox: string;
        versions: string;
      }>(
        `select
        (select count(*) from app.audit_events where workspace_id = $1 and target_id = $2 and action = 'workflow.published')::text as audits,
        (select count(*) from app.outbox_events where workspace_id = $1 and aggregate_id = $2 and job_name = 'reconcile-workflow-triggers')::text as outbox,
        (select count(*) from app.workflow_versions where workspace_id = $1 and workflow_id = $2)::text as versions`,
        [workspaceId, workflowId],
      );
      expect(facts.rows[0]).toEqual({
        audits: '3',
        outbox: '3',
        versions: '1',
      });
      await api.query('rollback');
      apiOpen = false;
    } catch (error: unknown) {
      apiError = error;
    }
    await finishTransactionClient(api, {
      label: 'Publication durable-facts proof',
      primaryError: apiError,
      transactionOpen: apiOpen,
    });
  });
});
