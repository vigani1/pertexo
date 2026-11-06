import { expect, it } from 'vitest';
import {
  AuthoringValidationUnavailableError,
  WorkflowAuthoringValidator,
} from '@pertexo/workflow-model/server';
import {
  actorId,
  apiUrl,
  authoring,
  createWorkflowAuthoringStore,
  currentRepresentationTag,
  deferred,
  draftNode,
  emptyGraph,
  parseDatabaseConfig,
  queryAsOwner,
  randomUUID,
  testDefinitionCatalog,
  waitForOperationEntry,
  workspaceId,
} from '../../support/workflow-authoring.js';

it('returns the checked saved revision when a concurrent save changes the draft during validation', async () => {
  const invalidGraph = {
    ...emptyGraph,
    nodes: [
      {
        ...draftNode('action'),
        inputMappings: {
          value: {
            kind: 'expression' as const,
            language: 'jsonata' as const,
            expression: '(',
          },
        },
      },
    ],
  };
  const created = await authoring.createWorkflow({
    actorId,
    workspaceId,
    name: 'Checked snapshot',
    emptyGraph: invalidGraph,
    idempotencyKey: randomUUID(),
  });
  const entered = deferred();
  const resume = deferred();
  const validator = new WorkflowAuthoringValidator();
  const checker = createWorkflowAuthoringStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    {
      definitionCatalog: testDefinitionCatalog,
      validateAuthoringGraph: async (graph, options) => {
        entered.resolve();
        await resume.promise;
        return validator.validate(
          graph,
          {
            definitions: testDefinitionCatalog.definitions.map(
              ({ key, version }) => ({
                definition: { key, version },
                policyReferences: [{ key: 'jsonata.restricted', version: 1 }],
              }),
            ),
          },
          options,
        );
      },
    },
  );
  const checking = checker.validateDraft(
    workspaceId,
    created.workflowId,
    actorId,
  );
  try {
    await waitForOperationEntry(
      entered.promise,
      checking,
      'selected draft validation',
    );
    const saved = await authoring.saveDraft({
      workspaceId,
      actorId,
      workflowId: created.workflowId,
      expectedRevision: 1,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
      ),
      graphJson: emptyGraph,
    });
    expect(saved.revision).toBe(2);
    resume.resolve();
    expect(await checking).toMatchObject({
      draft: { revision: 1, graphJson: invalidGraph },
      validation: {
        ok: false,
        issues: [
          {
            code: 'invalid_expression',
            path: '$.nodes.action.inputMappings.value',
          },
        ],
      },
      currentPublication: null,
    });
    expect(
      (await authoring.getDraft(workspaceId, created.workflowId, actorId))
        ?.revision,
    ).toBe(2);
  } finally {
    resume.resolve();
    await checking.catch(() => undefined);
    await checker.close();
    await validator.shutdown();
  }
});

it.each(['overloaded', 'canceled'] as const)(
  'leaves no publication effects after the external validator is %s',
  async (kind) => {
    const created = await authoring.createWorkflow({
      actorId,
      workspaceId,
      name: 'Refused validation',
      emptyGraph,
      idempotencyKey: randomUUID(),
    });
    const entered = deferred();
    const controller = new AbortController();
    const publisher = createWorkflowAuthoringStore(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      {
        validateAuthoringGraph: (_graph, options) => {
          entered.resolve();
          if (kind === 'overloaded')
            return Promise.reject(
              new AuthoringValidationUnavailableError('overloaded'),
            );
          return new Promise((_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => {
                reject(new DOMException('Validator canceled', 'AbortError'));
              },
              { once: true },
            );
          });
        },
      },
    );
    try {
      const publishing = publisher.publishWorkflow({
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
        signal: controller.signal,
      });
      // Observe a rejection immediately; controlled cancellation can otherwise race the assertion.
      const result = publishing.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (kind === 'canceled') {
        await waitForOperationEntry(
          entered.promise,
          publishing,
          'external validator',
        );
        controller.abort();
      }
      expect(await result).toMatchObject({
        ok: false,
        error:
          kind === 'overloaded'
            ? { reason: 'overloaded' }
            : { name: 'AbortError' },
      });
      const stored = await queryAsOwner(
        `select
      (select count(*)::int from app.workflow_versions where workflow_id=$1) versions,
      (select count(*)::int from app.audit_events where target_id=$1 and action='workflow.published') audits,
      (select count(*)::int from app.idempotency_records where resource_id=$1 and operation='workflow.publish') receipts`,
        [created.workflowId],
        workspaceId,
      );
      expect(stored).toEqual([{ versions: 0, audits: 0, receipts: 0 }]);
      expect(
        (await authoring.getDraft(workspaceId, created.workflowId, actorId))
          ?.revision,
      ).toBe(1);
    } finally {
      controller.abort();
      await publisher.close();
    }
  },
);
