import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createWorkflowAuthoringDatabase } from '@pertexo/database/authoring';
import {
  createConnectionDatabase,
  CONNECTION_AUTH_TYPE,
} from '@pertexo/database/connections';
import { createDataTablesStore } from '@pertexo/database/data-tables';
import { createWorkspaceVariablesStore } from '@pertexo/core/variables';
import { createWorkflowRunDatabase } from '@pertexo/database/runs';
import { createIdentityWorkspaceDatabase } from '@pertexo/database/tenant-access';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import {
  createConnectionEnvelopeEncryption,
  parseConnectionEncryptionConfig,
} from '@pertexo/integrations/server';
import { HTTP_REQUEST_CONNECTION_SLOT } from '@pertexo/integrations';
import {
  createPlatformNodeRegistry,
  platformPortableDefinitionPolicy,
} from '@pertexo/node-catalog/server';
import { buildWorkflowExecutable } from '@pertexo/workflow-engine';
import { initialCheckpointFactory } from '@pertexo/execution';
import {
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
  WorkflowAuthoringValidator,
} from '@pertexo/workflow-model/server';
import {
  EMPTY_WORKFLOW_GRAPH,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { createWorkerNodeRuntimeCapabilities } from '../../../../src/attempts/execution/runtime-capabilities.js';
import { createEditorControlledHttpTarget } from '../../../support/editor-browser/controlled-http.js';
import { runWithCleanup } from '../../../support/infrastructure/test-operation.js';
import { fixture, node, edge, runtime } from '../../calls/fixtures.js';
import { catalog, definitions, policies } from './fixture.js';
import { createPromotionChildGraph } from './graphs.js';

export function registerUsesDestinationCredentialsVariablesTableRows(): void {
  it('uses destination credentials, variables, table rows and exact child versions without copying source state', async () => {
    const config = parseDatabaseConfig({
      connectionString: fixture.databaseUrl(fixture.apiUrl),
      max: 3,
    });
    const workerConfig = parseDatabaseConfig({
      connectionString: fixture.databaseUrl(fixture.workerUrl),
      max: 6,
    });
    const validator = new WorkflowAuthoringValidator();
    const authoring = createWorkflowAuthoringDatabase(config, {
      definitionCatalog: definitions,
      portableCatalog: platformPortableDefinitionPolicy(),
      validateAuthoringGraph: (graph, options) =>
        validator.validate(graph, policies, options),
      executableCompiler: (graph) => {
        const compiled = buildWorkflowExecutable({ graph, catalog });
        return {
          checksum: compiled.checksum,
          executableJson: compiled.envelope,
        };
      },
    });
    const identity = createIdentityWorkspaceDatabase(config),
      connections = createConnectionDatabase(config),
      tables = createDataTablesStore(config),
      variables = createWorkspaceVariablesStore(config),
      runs = createWorkflowRunDatabase(config);
    const encryptionConfig = parseConnectionEncryptionConfig(
      {
        CONNECTION_ENCRYPTION_MODE: 'self-managed',
        CONNECTION_SELF_MANAGED_KEY: Buffer.alloc(32, 0x4d).toString('base64'),
        CONNECTION_SELF_MANAGED_KEY_VERSION: 'promotion-v1',
      },
      { deployed: false },
    );
    if (encryptionConfig === undefined)
      throw new Error('Fixture encryption missing');
    const encryption = createConnectionEnvelopeEncryption(encryptionConfig);
    const target = createEditorControlledHttpTarget('Bearer target-only');
    let capabilities:
      | Awaited<ReturnType<typeof createWorkerNodeRuntimeCapabilities>>
      | undefined;
    let workers: Awaited<ReturnType<typeof runtime>> | undefined;
    await runWithCleanup(
      async () => {
        await target.start();
        const actorId = fixture.actorId,
          sourceId = fixture.workspaceId;
        const targetWorkspace = await identity.createWorkspaceWithOwner({
          ownerUserId: actorId,
          name: 'Promotion target',
          slug: `promotion-${randomUUID().slice(0, 8)}`,
          idempotencyKey: randomUUID(),
        });
        const targetId = targetWorkspace.id;
        const scope = (workspaceId: string) => ({ workspaceId, actorId });
        async function connection(workspaceId: string, authorization: string) {
          const connectionId = randomUUID(),
            secretVersionId = randomUUID();
          const sealed = await encryption.encryption.seal(
            Buffer.from(
              JSON.stringify({
                type: CONNECTION_AUTH_TYPE.httpHeaders,
                headers: { authorization },
              }),
            ),
            { workspaceId, connectionId, secretVersionId },
          );
          await connections.createConnection({
            ...scope(workspaceId),
            connectionId,
            secretVersionId,
            providerKey: 'http',
            name: 'Service',
            authType: CONNECTION_AUTH_TYPE.httpHeaders,
            idempotencyKey: randomUUID(),
            requestHash: 'a'.repeat(64),
            sealed,
          });
          return connectionId;
        }
        const sourceConnection = await connection(
            sourceId,
            'Bearer source-only',
          ),
          targetConnection = await connection(targetId, 'Bearer target-only');
        for (const [workspaceId, amount, rate] of [
          [sourceId, 100, 42],
          [targetId, 900, 7],
        ] as const) {
          await variables.replace({
            ...scope(workspaceId),
            expectedRevision: 0,
            values: { RATE: rate },
            idempotencyKey: randomUUID(),
          });
          const table = await tables.create({
            ...scope(workspaceId),
            name: 'Orders',
            columns: [
              { name: 'key', type: 'text', required: true },
              { name: 'amount', type: 'number', required: true },
            ],
            keyColumn: 'key',
            idempotencyKey: randomUUID(),
          });
          await tables.importRows({
            ...scope(workspaceId),
            tableId: table.id,
            rows: [{ key: 'a', amount }],
            idempotencyKey: randomUUID(),
          });
        }
        const { resultType, child } =
          createPromotionChildGraph(sourceConnection);
        async function publish(graph: WorkflowGraph, name: string) {
          const created = await authoring.createWorkflow({
            ...scope(sourceId),
            name,
            emptyGraph: EMPTY_WORKFLOW_GRAPH,
            idempotencyKey: randomUUID(),
          });
          const tag = workflowDraftRepresentationTag({
            workflowId: created.workflowId,
            revision: 1,
            graph: created.draft.graphJson,
            compatibilityFingerprint: created.draft.compatibility.fingerprint,
          });
          const draft = await authoring.saveDraft({
            ...scope(sourceId),
            workflowId: created.workflowId,
            representationTag: tag,
            expectedRevision: 1,
            graphJson: graph,
          });
          const representationTag = workflowDraftRepresentationTag({
            workflowId: created.workflowId,
            revision: draft.revision,
            graph: draft.graphJson,
            compatibilityFingerprint: workflowCompatibilityReport(
              draft.graphJson,
              definitions,
            ).fingerprint,
          });
          const validation = await authoring.validateDraft(
            sourceId,
            created.workflowId,
            actorId,
          );
          expect(
            validation?.validation,
            JSON.stringify(validation?.validation.issues),
          ).toMatchObject({ ok: true });
          return (
            await authoring.publishWorkflow({
              ...scope(sourceId),
              workflowId: created.workflowId,
              representationTag,
              requestHash: 'a'.repeat(64),
              idempotencyKey: randomUUID(),
            })
          ).version;
        }
        const childVersion = await publish(child, 'Child');
        const parent: WorkflowGraph = {
          settings: { maxRunDurationMs: 60000 },
          callable: {
            input: { type: 'object', properties: [] },
            resultType,
            result: { kind: 'node_output', nodeId: 'call', path: '$' },
          },
          nodes: [
            node('manual', 'core.manual'),
            {
              ...node('call', 'core.call'),
              config: {
                target: {
                  workflowId: childVersion.workflowId,
                  workflowVersionId: childVersion.id,
                  executableChecksum: childVersion.checksum,
                },
              },
              inputMappings: { input: { kind: 'literal', value: {} } },
            },
            node('finish', 'core.terminate'),
          ],
          edges: [edge('manual', 'call'), edge('call', 'finish')],
        };
        const parentVersion = await publish(parent, 'Parent');
        const promotions = authoring.promotions;
        if (promotions === undefined)
          throw new Error('Promotion owner missing');
        await promotions.setTarget({
          ...scope(sourceId),
          expectedRevision: 0,
          expectedTargetWorkspaceId: null,
          targetWorkspaceId: targetId,
          idempotencyKey: randomUUID(),
        });
        const promote = async (version: typeof childVersion) => {
          const selections = [
            { workflowId: version.workflowId, versionId: version.id },
          ];
          const review = await promotions.preview({
            ...scope(sourceId),
            selections,
            mode: 'publish',
          });
          expect(review.compatible, JSON.stringify(review.requirements)).toBe(
            true,
          );
          const result = await promotions.apply({
            ...scope(sourceId),
            selections,
            mode: 'publish',
            fingerprint: review.fingerprint,
            acknowledgeTargetChanges: [],
            idempotencyKey: randomUUID(),
          });
          const item = result.items[0];
          if (item === undefined) throw new Error('Promoted target missing');
          return item;
        };
        const promotedChild = await promote(childVersion),
          promotedParent = await promote(parentVersion);
        const destination = await authoring.getVersion(
          targetId,
          promotedChild.targetWorkflowId,
          promotedChild.publishedVersionId ?? '',
          actorId,
        );
        expect(
          destination?.graphJson.nodes.find((step) => step.id === 'http')
            ?.connectionRefs[HTTP_REQUEST_CONNECTION_SLOT],
        ).toBe(targetConnection);
        capabilities = await createWorkerNodeRuntimeCapabilities({
          database: workerConfig,
          connectionEncryption: encryptionConfig,
          redisUrl: fixture.redisUrl,
        });
        workers = await runtime(
          createPlatformNodeRegistry({
            httpRequest: { httpClient: target.httpClient },
          }),
          capabilities.factories,
        );
        const digest = createHash('sha256').update(randomUUID()).digest('hex');
        const accepted = await runs.start({
          ...scope(targetId),
          workflowId: promotedParent.targetWorkflowId,
          scope: `workflow:${promotedParent.targetWorkflowId}:manual`,
          input: {},
          requestHash: digest,
          idempotencyKeyHash: digest,
          checkpointFactory: initialCheckpointFactory({ catalog }),
        });
        await workers.until(async () => {
          const stored = await fixture.ownerQuery<{
            status: string;
            output_ref: unknown;
            error_summary: unknown;
          }>(
            'select status,output_ref,error_summary from app.workflow_runs where workspace_id=$1 and id=$2',
            [targetId, accepted.run.id],
          );
          expect(stored).toEqual([
            {
              status: 'succeeded',
              output_ref: {
                kind: 'inline',
                value: { rate: 7, amount: 900 },
              },
              error_summary: null,
            },
          ]);
        });
        expect(target.observe()).toMatchObject({
          requests: 1,
          effects: 1,
          bodies: ['{"marker":"promoted-target"}'],
        });
        expect((await variables.read(scope(sourceId))).values.RATE).toBe(42);
        expect(
          (
            await authoring.getVersion(
              sourceId,
              childVersion.workflowId,
              childVersion.id,
              actorId,
            )
          )?.graphJson,
        ).toEqual(child);
      },
      async () => {
        const failures: unknown[] = [];
        const cleanups = [
          () => workers?.close(),
          () => capabilities?.close(),
          () => target.close(),
          () => {
            encryption.close();
          },
          () => validator.shutdown(),
          () =>
            Promise.all([
              authoring.close(),
              identity.close(),
              connections.close(),
              tables.close(),
              variables.close(),
              runs.close(),
            ]),
        ];
        for (const cleanup of cleanups) {
          try {
            await Promise.resolve().then(cleanup);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0)
          throw new AggregateError(failures, 'Promotion worker cleanup failed');
      },
      'Promoted worker execution',
    );
  }, 60000);
}
