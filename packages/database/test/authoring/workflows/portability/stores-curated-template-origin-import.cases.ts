import { expect, it } from 'vitest';

import { workflowDefinitionCatalogFingerprint } from '@pertexo/workflow-model/server';
import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import {
  WorkflowPortabilityCompatibilityConflictError,
  WorkflowPortabilityValidationError,
} from '../../../../src/authoring/workflows/errors.js';

import { workflowImportCommandDigest } from '../../../../src/authoring/portability/repository.js';

import {
  actorId,
  workspaceId,
  emptyGraph,
  failAtWrite,
  importWrite,
  randomUUID,
  queryAsOwner,
  IdempotencyConflictError,
} from '../../../support/workflow-authoring.js';
import { catalog, database, command, facts, firstFacts } from './fixture.js';

export function registerStoresCuratedTemplateOriginImport(): void {
  it('stores a curated template origin with its import command digest', async () => {
    const template = CURATED_WORKFLOW_TEMPLATES.find(
      ({ templateId }) => templateId === 'webhook-validation-routing',
    );
    if (template === undefined) throw new Error('Expected a curated template');
    const { definitions } = template.manifest.requirements;
    const templateCatalog = {
      ...catalog,
      definitions: definitions.map(({ key, version }) => ({ key, version })),
    };
    const db = database({
      definitionCatalog: templateCatalog,
      portableCatalog: {
        definitions: definitions.map((definition) => ({
          ...definition,
          slots: [],
          validateConfig: () => true,
        })),
        validateTemplateSetup: () => true,
      },
    });
    const templateOrigin = {
      templateId: template.templateId,
      templateVersion: template.templateVersion,
      baseManifestDigest: template.baseManifestDigest,
    };
    const input = command({
      manifest: template.manifest,
      templateOrigin,
      expectedCompatibilityFingerprint:
        workflowDefinitionCatalogFingerprint(templateCatalog),
    });
    const { workflowId } = await db.importWorkflow(input);
    expect(
      await db.getWorkflowWithTemplateOrigin(workspaceId, workflowId, actorId),
    ).toMatchObject({
      templateOrigin: {
        ...templateOrigin,
        creationCommandDigest: workflowImportCommandDigest(input),
        derivation: 'direct',
      },
    });
    const changed = {
      ...template.manifest,
      graph: {
        ...template.manifest.graph,
        settings: { maxRunDurationMs: 1000 },
      },
    };
    await expect(
      db.importWorkflow(
        command({ ...input, manifest: changed, idempotencyKey: randomUUID() }),
      ),
    ).rejects.toBeInstanceOf(WorkflowPortabilityValidationError);
  });

  it('creates one normal-default unpublished revision-1 draft, safe audit and identifier-only receipt atomically', async () => {
    const db = database();
    const input = command({ name: '  Trimmed destination  ' });
    const before = await firstFacts();
    const accepted = await db.importWorkflow(input);
    const draft = await db.getDraft(workspaceId, accepted.workflowId, actorId);
    expect(draft).toMatchObject({ revision: 1, graphJson: emptyGraph });
    const workflow = await db.getWorkflow(
      workspaceId,
      accepted.workflowId,
      actorId,
    );
    expect(workflow).toMatchObject({
      name: 'Trimmed destination',
      nameRevision: 1,
      lifecycleRevision: 1,
      lifecycleStatus: 'active',
      activationStatus: 'inactive',
      publishedVersionId: null,
    });
    const rows = await queryAsOwner(
      `select scope,result_ref,resource_id::text,expires_at-created_at ttl from app.idempotency_records where workspace_id=$1 and operation='workflow.import' and resource_id=$2`,
      [workspaceId, accepted.workflowId],
      workspaceId,
    );
    expect(rows[0]).toMatchObject({
      scope: actorId,
      resource_id: accepted.workflowId,
      result_ref: accepted,
    });
    expect(Object.keys(accepted)).toEqual(['workflowId']);
    expect((await facts())[0]).toEqual({
      workflows: Number(before.workflows) + 1,
      drafts: Number(before.drafts) + 1,
      receipts: Number(before.receipts) + 1,
      audits: Number(before.audits) + 1,
    });
    const audits = await queryAsOwner(
      'select metadata from app.audit_events where workspace_id=$1 and action=$2 and target_id=$3',
      [workspaceId, 'workflow.imported', accepted.workflowId],
      workspaceId,
    );
    expect(audits).toEqual([{ metadata: { revision: 1 } }]);
  });

  it('replays after restart without later catalog/binding checks and conflicts on any changed frozen command', async () => {
    const first = database();
    const input = command();
    const result = await first.importWorkflow(input);
    await first.close();
    const restarted = database({
      definitionCatalog: { ...catalog, definitions: [] },
    });
    expect(await restarted.importWorkflow(input)).toEqual(result);
    for (const changed of [
      { name: 'Changed' },
      {
        expectedCompatibilityFingerprint: `wf-compat:sha256:${'0'.repeat(64)}`,
      },
      {
        manifest: {
          ...input.manifest,
          graph: {
            ...input.manifest.graph,
            settings: { maxRunDurationMs: 1000 },
          },
        },
      },
    ]) {
      await expect(
        restarted.importWorkflow({ ...input, ...changed }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    }
  });

  it('serializes concurrent same-key requests and accepts distinct keys independently', async () => {
    const db = database();
    const input = command();
    const before = await firstFacts();
    const accepted = await Promise.all(
      Array.from({ length: 4 }, () => db.importWorkflow(input)),
    );
    expect(new Set(accepted.map(({ workflowId }) => workflowId)).size).toBe(1);
    expect(Number((await firstFacts()).workflows)).toBe(
      Number(before.workflows) + 1,
    );
    const independent = await Promise.all([
      db.importWorkflow(command()),
      db.importWorkflow(command()),
    ]);
    expect(independent[0].workflowId).not.toBe(independent[1].workflowId);
    const raced = command();
    const settled = await Promise.allSettled([
      db.importWorkflow(raced),
      db.importWorkflow({ ...raced, name: 'Different command' }),
    ]);
    expect(
      settled.filter((entry) => entry.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = settled.find((entry) => entry.status === 'rejected');
    expect(rejected?.reason instanceof IdempotencyConflictError).toBe(true);
  });

  it.each(['claim', 'workflow', 'draft', 'audit', 'idempotency'] as const)(
    'rolls back all import facts after a failed %s write',
    async (step) => {
      const db = database();
      const input = command();
      const before = await facts();
      const fault = await failAtWrite(importWrite(step, input.name));
      try {
        await expect(db.importWorkflow(input)).rejects.toThrow(fault.message);
      } finally {
        await fault.remove();
      }
      expect(await facts()).toEqual(before);
    },
  );

  it('requires fresh compatibility preview, exact graph requirements and new-placement authority', async () => {
    const db = database();
    const before = await facts();
    await expect(
      db.importWorkflow(
        command({
          expectedCompatibilityFingerprint: `wf-compat:sha256:${'0'.repeat(64)}`,
        }),
      ),
    ).rejects.toBeInstanceOf(WorkflowPortabilityCompatibilityConflictError);
    const input = command();
    await expect(
      db.importWorkflow({
        ...input,
        manifest: {
          ...input.manifest,
          requirements: {
            ...input.manifest.requirements,
            definitions: [
              { key: 'test.placeholder', version: 1, configVersion: 1 },
            ],
          },
        },
      }),
    ).rejects.toBeInstanceOf(WorkflowPortabilityValidationError);
    expect(await facts()).toEqual(before);
  });
}
