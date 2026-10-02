import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/workflow-model/curated-templates';
import type { WorkflowPortabilityCatalog } from '@pertexo/workflow-model/portability';
import { createWorkflowPortabilityStore } from '../src/authoring/workflow-authoring-portability.js';
import { workflowImportCommandIdentity } from '../src/authoring/workflow-portability-receipts.js';
import {
  inspectCuratedTemplateOrigin,
  readCuratedTemplateDescriptor,
} from '../src/authoring/workflow-curated-template-origin.js';
import type { WorkflowAuthoringWriteContext } from '../src/authoring/workflow-authoring-context.js';
import type { ImportWorkflowInput } from '../src/authoring/workflow-authoring-contracts.js';
import {
  createWorkflowAuthoringReadStore,
  type WorkflowAuthoringReadContext,
} from '../src/authoring/workflow-authoring-reads.js';
import {
  WorkflowPortabilityUnavailableError,
  WorkflowTemplateOriginUnavailableError,
} from '../src/authoring/workflow-authoring-errors.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const template = (() => {
  const reviewed = CURATED_WORKFLOW_TEMPLATES[0];
  if (reviewed === undefined)
    throw new Error('Reviewed template asset is missing');
  return reviewed;
})();
const origin = {
  schemaVersion: 1,
  templateId: template.templateId,
  templateVersion: template.templateVersion,
  baseManifestDigest: template.baseManifestDigest,
} as const;
const command = {
  workspaceId,
  actorId,
  name: 'Example',
  idempotencyKey: 'example',
  manifest: template.manifest,
  bindings: [],
  expectedCompatibilityFingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
  templateOrigin: origin,
};
function descriptor(selectionEnabled = true) {
  return {
    ...origin,
    manifest: template.manifest,
    setupTargets: template.setupTargets,
    supportedProfile: template.supportedProfile,
    selectionEnabled,
  };
}

describe('curated template new-command verification', () => {
  it('uses confined lock helper for creation and an unlocked descriptor SELECT for advisory preview', async () => {
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ descriptor: descriptor() }] });
    const client = { query } as unknown as PoolClient;
    const locked = await readCuratedTemplateDescriptor(client, command, true);
    expect(query).toHaveBeenLastCalledWith(
      'select app.lock_curated_template_descriptor($1,$2) descriptor',
      [origin.templateId, 1],
    );
    expect(locked).toEqual(descriptor());
    await readCuratedTemplateDescriptor(client, command, false);
    expect(query.mock.lastCall?.[0]).toContain(
      'from app.curated_template_descriptors',
    );
    expect(query.mock.lastCall?.[0]).not.toContain('for share');
  });

  it('fails closed on installed content drift but never looks up descriptors for ordinary imports', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          descriptor: { ...descriptor(), baseManifestDigest: 'b'.repeat(64) },
        },
      ],
    });
    const client = { query } as unknown as PoolClient;
    await expect(
      readCuratedTemplateDescriptor(client, command, true),
    ).rejects.toBeInstanceOf(WorkflowPortabilityUnavailableError);
    query.mockClear();
    const { templateOrigin: _origin, ...ordinary } = command;
    expect(
      await readCuratedTemplateDescriptor(client, ordinary, true),
    ).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('requires selected registered typed policy in addition to model verification', () => {
    const validateTemplateSetup = vi.fn().mockReturnValue(true);
    const catalog = {
      validateTemplateSetup,
    } as unknown as WorkflowPortabilityCatalog;
    expect(
      inspectCuratedTemplateOrigin(command, descriptor(), catalog),
    ).toEqual([]);
    expect(validateTemplateSetup).toHaveBeenCalledWith(
      command.manifest,
      origin,
    );
    validateTemplateSetup.mockReturnValue(false);
    expect(
      inspectCuratedTemplateOrigin(command, descriptor(), catalog),
    ).toMatchObject([{ code: 'template_setup_invalid' }]);
    expect(() =>
      inspectCuratedTemplateOrigin(
        command,
        descriptor(),
        {} as WorkflowPortabilityCatalog,
      ),
    ).toThrow(WorkflowPortabilityUnavailableError);
  });

  it('reports removed/unknown selection without calling registered policy and rejects non-target graph changes', () => {
    const validateTemplateSetup = vi.fn();
    const catalog = {
      validateTemplateSetup,
    } as unknown as WorkflowPortabilityCatalog;
    expect(
      inspectCuratedTemplateOrigin(command, descriptor(false), catalog),
    ).toMatchObject([{ code: 'template_origin_unavailable' }]);
    expect(inspectCuratedTemplateOrigin(command, null, catalog)).toMatchObject([
      { code: 'template_origin_unavailable' },
    ]);
    const changed = {
      ...command,
      manifest: {
        ...command.manifest,
        graph: {
          ...command.manifest.graph,
          nodes: command.manifest.graph.nodes.map((node, index) =>
            index === 0
              ? {
                  ...node,
                  position: { ...node.position, x: node.position.x + 1 },
                }
              : node,
          ),
        },
      },
    };
    expect(
      inspectCuratedTemplateOrigin(changed, descriptor(), catalog),
    ).toMatchObject([{ code: 'template_manifest_mismatch' }]);
    expect(validateTemplateSetup).not.toHaveBeenCalled();
  });
});

function runtime(
  replay: boolean,
  templateEnabled = true,
  input: ImportWorkflowInput = command,
) {
  const statements: string[] = [];
  let destinationId = workflowId;
  const query = vi.fn((sql: string, values?: unknown[]) => {
    statements.push(sql);
    if (sql.startsWith('insert into app.idempotency_records'))
      destinationId = String(values?.[5]);
    if (sql.includes('select request_hash,status'))
      return Promise.resolve({
        rows: [
          {
            request_hash: workflowImportCommandIdentity(input).requestHash,
            status: replay ? 'completed' : 'in_progress',
            resource_id: replay ? workflowId : destinationId,
            result_ref: { workflowId },
          },
        ],
        rowCount: 1,
      });
    if (sql.includes('workflow_portability_rollout'))
      return Promise.resolve({ rows: [{ import_enabled: true }], rowCount: 1 });
    if (sql.includes('curated_template_rollout'))
      return Promise.resolve({
        rows: [{ import_enabled: templateEnabled }],
        rowCount: 1,
      });
    if (sql.includes('curated_template_descriptor'))
      return Promise.resolve({
        rows: [{ descriptor: descriptor() }],
        rowCount: 1,
      });
    return Promise.resolve({
      rows: [{ status: 'active', id: workflowId }],
      rowCount: 1,
    });
  });
  const client = { query } as unknown as PoolClient;
  const reachedCatalog = new Error('catalog reached');
  const selectCatalogs = vi.fn().mockRejectedValue(reachedCatalog);
  const context = {
    keyDigest: () => 'a'.repeat(64),
    transact: (
      _workspace: string,
      _actor: string,
      operation: (client: PoolClient) => Promise<unknown>,
    ) => operation(client),
    selectCatalogs,
  } as unknown as WorkflowAuthoringWriteContext;
  return {
    store: createWorkflowPortabilityStore(context),
    statements,
    selectCatalogs,
    reachedCatalog,
  };
}

describe('curated import replay and lock order', () => {
  it('preserves ordinary new imports with no new gate or descriptor lookup', async () => {
    const { templateOrigin: _origin, ...ordinary } = command;
    const f = runtime(false, false, ordinary);
    await expect(f.store.importWorkflow(ordinary)).rejects.toBe(
      f.reachedCatalog,
    );
    expect(f.statements.join('\n')).toContain('workflow_portability_rollout');
    expect(f.statements.join('\n')).not.toContain('curated_template');
  });

  it('preview is advisory and does not acquire creation gates or receipt locks', async () => {
    const f = runtime(false, false);
    await expect(
      f.store.previewWorkflowImport({
        workspaceId,
        actorId,
        manifest: command.manifest,
        bindings: [],
        templateOrigin: origin,
      }),
    ).rejects.toBe(f.reachedCatalog);
    expect(f.statements.join('\n')).toContain(
      'from app.curated_template_descriptors',
    );
    expect(f.statements.join('\n')).not.toContain('rollout');
    expect(f.statements.join('\n')).not.toContain('idempotency_records');
    expect(f.statements.join('\n')).not.toContain(
      'lock_curated_template_descriptor',
    );
  });
  it('returns retained origin-bearing destination before disabled writer, removed descriptor, or catalog checks', async () => {
    const f = runtime(true, false);
    expect(await f.store.importWorkflow(command)).toEqual({ workflowId });
    expect(f.selectCatalogs).not.toHaveBeenCalled();
    expect(f.statements.join('\n')).not.toContain('rollout');
    expect(f.statements.join('\n')).not.toContain(
      'curated_template_descriptor',
    );
    expect(f.statements.at(-1)).toContain('from app.workflows');
  });

  it('locks ordinary gate then template gate then descriptor before selecting serving catalog', async () => {
    const f = runtime(false);
    await expect(f.store.importWorkflow(command)).rejects.toBe(
      f.reachedCatalog,
    );
    const ordinaryGate = f.statements.findIndex((sql) =>
      sql.includes('workflow_portability_rollout'),
    );
    const templateGate = f.statements.findIndex((sql) =>
      sql.includes('curated_template_rollout'),
    );
    const descriptorLock = f.statements.findIndex((sql) =>
      sql.includes('lock_curated_template_descriptor'),
    );
    expect(ordinaryGate).toBeGreaterThan(0);
    expect(templateGate).toBeGreaterThan(ordinaryGate);
    expect(descriptorLock).toBeGreaterThan(templateGate);
    expect(f.statements[templateGate]).toContain('for share');
    expect(f.selectCatalogs).toHaveBeenCalledOnce();
  });

  it('refuses new origin commands at disabled template gate without descriptor/catalog access', async () => {
    const f = runtime(false, false);
    await expect(f.store.importWorkflow(command)).rejects.toBeInstanceOf(
      WorkflowPortabilityUnavailableError,
    );
    expect(f.statements.join('\n')).not.toContain(
      'lock_curated_template_descriptor',
    );
    expect(f.selectCatalogs).not.toHaveBeenCalled();
  });
});

const workflowRow = {
  id: workflowId,
  workspace_id: workspaceId,
  name: 'Example',
  name_revision: 1,
  lifecycle_status: 'active',
  lifecycle_revision: 1,
  activation_status: 'inactive',
  published_version_id: null,
  created_by: actorId,
  created_at: '2026-10-02T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
};
const retainedOrigin = {
  ...origin,
  creationCommandDigest: 'c'.repeat(64),
  derivation: 'direct',
};
function reader(rows: unknown[] = [], error?: unknown) {
  const query =
    error === undefined
      ? vi.fn().mockResolvedValue({ rows })
      : vi.fn().mockRejectedValue(error);
  const requireReader = vi.fn().mockResolvedValue(undefined);
  const context = {
    requireReader,
    transact: (
      _workspace: string,
      _actor: string,
      operation: (client: PoolClient) => Promise<unknown>,
    ) => operation({ query } as unknown as PoolClient),
  } as unknown as WorkflowAuthoringReadContext;
  return {
    store: createWorkflowAuthoringReadStore(context),
    query,
    requireReader,
  };
}
describe('authoritative scoped historical-origin read', () => {
  it.each([null, retainedOrigin])(
    'reads workflow and origin in one statement without current descriptor lookup (%j)',
    async (template_origin) => {
      const f = reader([{ workflow: workflowRow, template_origin }]);
      const result = await f.store.getWorkflowWithTemplateOrigin(
        workspaceId,
        workflowId,
        actorId,
      );
      expect(result).toMatchObject({
        workflow: { id: workflowId },
        templateOrigin: template_origin,
      });
      expect(f.requireReader).toHaveBeenCalledWith(
        expect.anything(),
        workspaceId,
        actorId,
      );
      expect(f.query).toHaveBeenCalledOnce();
      expect(f.query.mock.lastCall?.[0]).toContain(
        'left join app.workflow_template_origins',
      );
      expect(f.query.mock.lastCall?.[0]).not.toContain(
        'curated_template_descriptors',
      );
      expect(f.query.mock.lastCall?.[1]).toEqual([workspaceId, workflowId]);
    },
  );

  it('denies before reading and returns null only for a missing visible workflow', async () => {
    const f = reader();
    expect(
      await f.store.getWorkflowWithTemplateOrigin(
        workspaceId,
        workflowId,
        actorId,
      ),
    ).toBeNull();
    f.query.mockClear();
    f.requireReader.mockRejectedValue(new Error('denied'));
    await expect(
      f.store.getWorkflowWithTemplateOrigin(workspaceId, workflowId, actorId),
    ).rejects.toThrow('denied');
    expect(f.query).not.toHaveBeenCalled();
  });

  it.each([undefined, { ...retainedOrigin, channelId: 'private' }])(
    'rejects missing or malformed evidence rather than origin-null (%j)',
    async (template_origin) => {
      await expect(
        reader([
          { workflow: workflowRow, template_origin },
        ]).store.getWorkflowWithTemplateOrigin(
          workspaceId,
          workflowId,
          actorId,
        ),
      ).rejects.toBeInstanceOf(WorkflowTemplateOriginUnavailableError);
    },
  );
  it.each(['42P01', '42703', '42501'])(
    'maps incompatible reader inventory %s to unavailable without raw details',
    async (code) => {
      await expect(
        reader([], {
          code,
          message: 'private diagnostic',
        }).store.getWorkflowWithTemplateOrigin(
          workspaceId,
          workflowId,
          actorId,
        ),
      ).rejects.toEqual(new WorkflowTemplateOriginUnavailableError());
    },
  );
});
