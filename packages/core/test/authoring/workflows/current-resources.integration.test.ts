import { afterAll, expect, it } from 'vitest';
import { setVariableSet } from '../../support/variable-sets.js';
import {
  approvalConfigSchema,
  InvalidWorkflowGraphError,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model';
import {
  CONNECTION_AUTH_TYPE,
  createConnectionStore,
  actorId,
  apiUrl,
  createWorkflowAuthoringStore,
  currentRepresentationTag,
  draftNode,
  emptyGraph,
  parseDatabaseConfig,
  queryAsOwner,
  randomUUID,
  workspaceId,
} from '../../support/workflow-authoring.js';

const authoring = createWorkflowAuthoringStore(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  {
    definitionCatalog: {
      definitions: ['test.placeholder', 'core.approval', 'core.call'].map(
        (key) => ({ key, version: 1 }),
      ),
    },
  },
);
const connections = createConnectionStore(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
);
afterAll(async () => {
  await Promise.all([authoring.close(), connections.close()]);
});

it.each(['variable', 'connection', 'task audience', 'Call pin'] as const)(
  'reports the same current %s failure at draft check and publication',
  async (kind) => {
    let step: WorkflowNode = { ...draftNode('step'), config: {} };
    if (kind === 'variable')
      step = {
        ...step,
        inputMappings: {
          result: { kind: 'workspace_variable', name: 'MISSING' },
        },
      };
    const connectionId = randomUUID();
    if (kind === 'connection') {
      await connections.createConnection({
        workspaceId,
        actorId,
        connectionId,
        secretVersionId: randomUUID(),
        providerKey: 'http',
        name: 'Draft check connection',
        authType: CONNECTION_AUTH_TYPE.httpHeaders,
        sealed: {
          kmsKeyReference: 'arn:aws:kms:eu-central-1:123456789012:key/check',
          encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
          ciphertext: Buffer.from('check').toString('base64url'),
          nonce: Buffer.alloc(12, 2).toString('base64url'),
          tag: Buffer.alloc(16, 3).toString('base64url'),
        },
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
      });
      step = { ...step, connectionRefs: { primary: connectionId } };
    }
    if (kind === 'task audience')
      step = {
        ...step,
        definition: { key: 'core.approval', version: 1 },
        config: approvalConfigSchema.parse({
          audience: { roles: [], memberIds: [randomUUID()] },
        }),
      };
    if (kind === 'Call pin') {
      const child = await authoring.createWorkflow({
        workspaceId,
        actorId,
        name: 'Visible Call target',
        emptyGraph,
        idempotencyKey: randomUUID(),
      });
      step = {
        ...step,
        definition: { key: 'core.call', version: 1 },
        config: {
          target: {
            workflowId: child.workflowId,
            workflowVersionId: randomUUID(),
            executableChecksum: `wf:sha256:${'a'.repeat(64)}`,
          },
        },
      };
    }
    const graph: WorkflowGraph = { ...emptyGraph, nodes: [step] };
    const { workflowId } = await authoring.createWorkflow({
      workspaceId,
      actorId,
      name: `Check ${kind}`,
      emptyGraph: graph,
      idempotencyKey: randomUUID(),
    });
    if (kind === 'connection') {
      expect(
        (await authoring.validateDraft(workspaceId, workflowId, actorId))
          ?.validation.ok,
      ).toBe(true);
      await connections.revokeConnection({
        workspaceId,
        actorId,
        connectionId,
      });
    }
    const checked = await authoring.validateDraft(
      workspaceId,
      workflowId,
      actorId,
    );
    expect(checked?.validation.ok).toBe(false);
    expect(checked?.validation.issues.length).toBeGreaterThan(0);
    await expect(
      authoring.publishWorkflow({
        workspaceId,
        actorId,
        workflowId,
        representationTag: await currentRepresentationTag(
          authoring,
          workspaceId,
          { scopedWorkflowId: workflowId, scopedActorId: actorId },
        ),
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({
      name: InvalidWorkflowGraphError.name,
      issues: checked?.validation.issues,
    });
    expect(
      await queryAsOwner(
        'select count(*)::int count from app.workflow_versions where workflow_id=$1',
        [workflowId],
        workspaceId,
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      (await authoring.getDraft(workspaceId, workflowId, actorId))?.graphJson,
    ).toEqual(graph);
    if (kind === 'variable') {
      await setVariableSet(workspaceId, { MISSING: 'configured' });
      expect(
        (await authoring.validateDraft(workspaceId, workflowId, actorId))
          ?.validation.ok,
      ).toBe(true);
      const published = await authoring.publishWorkflow({
        workspaceId,
        actorId,
        workflowId,
        representationTag: await currentRepresentationTag(
          authoring,
          workspaceId,
          { scopedWorkflowId: workflowId, scopedActorId: actorId },
        ),
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
      });
      expect(published.version.graphJson).toEqual(graph);
    }
  },
);
