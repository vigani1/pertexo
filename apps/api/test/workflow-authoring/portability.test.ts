import { describe, expect, it, vi } from 'vitest';
import {
  ExportWorkflowUseCase,
  ImportWorkflowUseCase,
  PreviewWorkflowImportUseCase,
} from '../../src/workflow-authoring/portability-use-cases.js';
import {
  authorizeWorkspace,
  createActorContext,
} from '../../src/workspaces/index.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workflowId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actorId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const tag = `"draft-v1.${'a'.repeat(43)}"`;
const fingerprint = `node-compat:v1:sha256:${'a'.repeat(64)}`;
const manifest = {
  format: 'pertexo.workflow',
  formatVersion: 1,
  graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
  requirements: {
    definitions: [],
    selectionFingerprint: `node-select:v1:sha256:${'a'.repeat(64)}`,
  },
  connectionSlots: [],
};
const boundManifest = {
  ...manifest,
  graph: {
    ...manifest.graph,
    nodes: [
      {
        id: workflowId,
        definition: { key: 'http.request', version: 1 },
        configVersion: 1,
        config: {
          method: 'GET',
          url: 'https://example.test/reviewed',
          headers: {},
          timeoutMillis: 1000,
          maxRedirects: 0,
          maxResponseBytes: 1024,
          inlineResponseBytes: 1024,
        },
        inputMappings: {},
        connectionRefs: {},
        position: { x: 0, y: 0 },
      },
    ],
  },
  requirements: {
    ...manifest.requirements,
    definitions: [{ key: 'http.request', version: 1, configVersion: 1 }],
  },
  connectionSlots: [
    {
      nodeId: workflowId,
      slot: 'http_headers',
      providerKey: 'http',
      authType: 'http_headers',
    },
  ],
};
const bindings = [
  { nodeId: workflowId, slot: 'http_headers', connectionId: actorId },
];
const context = {
  actor: createActorContext({
    actorId,
    workspaceId,
    sessionId: workflowId,
    requestId: 'portable-request',
  }),
  routeWorkspaceId: workspaceId,
};
function fixture(role: 'owner' | 'builder' | 'operator' | 'viewer' = 'owner') {
  const persistence = {
    exportWorkflow: vi.fn().mockResolvedValue(manifest),
    previewWorkflowImport: vi.fn().mockResolvedValue({
      manifestDigest: 'a'.repeat(64),
      compatibilityFingerprint: fingerprint,
      compatible: true,
      issues: [],
      truncated: false,
      connectionSlots: [],
    }),
    importWorkflow: vi.fn().mockResolvedValue({ workflowId }),
  };
  const authorization = {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role,
      membershipStatus: 'active',
      workspaceStatus: 'active',
    }),
  };
  return {
    persistence,
    authorization,
    export: new ExportWorkflowUseCase(persistence, authorization),
    preview: new PreviewWorkflowImportUseCase(persistence, authorization),
    import: new ImportWorkflowUseCase(persistence, authorization),
  };
}
describe('workflow portability application authority and exact commands', () => {
  const templateOrigin = {
    schemaVersion: 1,
    templateId: 'retired-reviewed-example',
    templateVersion: 1,
    baseManifestDigest: 'a'.repeat(64),
  } as const;

  it('forwards origin exactly and leaves retained replay before descriptor/writer checks to persistence', async () => {
    const f = fixture();
    const request = {
      manifest,
      bindings: [],
      name: 'Imported',
      expectedCompatibilityFingerprint: fingerprint,
      templateOrigin,
    };
    await f.preview.execute({
      ...context,
      request: { manifest, bindings: [], templateOrigin },
    });
    expect(f.persistence.previewWorkflowImport).toHaveBeenCalledWith(
      expect.objectContaining({ templateOrigin }),
    );
    await f.import.execute({
      ...context,
      request,
      idempotencyKey: 'retained-origin',
    });
    await f.import.execute({
      ...context,
      request,
      idempotencyKey: 'retained-origin',
    });
    expect(f.persistence.importWorkflow).toHaveBeenCalledTimes(2);
    expect(f.persistence.importWorkflow.mock.calls[0]?.[0]).toEqual(
      f.persistence.importWorkflow.mock.calls[1]?.[0],
    );
    expect(f.persistence.importWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        ...request,
        idempotencyKey: 'retained-origin',
      }),
    );
  });

  it.each([
    null,
    { ...templateOrigin, derivation: 'direct' },
    { ...templateOrigin, creationCommandDigest: 'b'.repeat(64) },
  ])(
    'rejects invalid request origin without disclosure (%j)',
    async (origin) => {
      const f = fixture();
      await expect(
        f.import.execute({
          ...context,
          idempotencyKey: 'invalid-origin',
          request: {
            manifest,
            bindings: [],
            name: 'Imported',
            expectedCompatibilityFingerprint: fingerprint,
            templateOrigin: origin,
          },
        }),
      ).rejects.toEqual({
        code: 'request.invalid',
        safeDetail: 'The portable workflow request is invalid.',
      });
      expect(f.persistence.importWorkflow).not.toHaveBeenCalled();
    },
  );

  it.each(['workflow:create', 'workflow:read'] as const)(
    'reuses only an issued matching %s guard proof and freshly authorizes bindings',
    async (capability) => {
      const f = fixture('builder');
      const actor = createActorContext({
        ...context.actor,
        traceId: 'portable-trace',
      });
      const authorizedWorkspace = await authorizeWorkspace({
        actor,
        routeWorkspaceId: workspaceId,
        capability,
        access: f.authorization,
        disclosure: 'not_found',
      });
      f.authorization.findAccess.mockClear();
      await f.preview.execute({
        ...context,
        actor,
        authorizedWorkspace,
        request: { manifest: boundManifest, bindings },
      });
      expect(f.authorization.findAccess).toHaveBeenCalledTimes(
        capability === 'workflow:create' ? 1 : 2,
      );
      expect(f.persistence.previewWorkflowImport).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'portable-trace',
          manifest: boundManifest,
          bindings,
        }),
      );
    },
  );
  it.each(['preview', 'import'] as const)(
    'denies %s before persistence when binding connection-read authority is lost',
    async (operation) => {
      const f = fixture('builder');
      f.authorization.findAccess.mockResolvedValueOnce({
        actorId,
        workspaceId,
        role: 'builder',
        membershipStatus: 'active',
        workspaceStatus: 'active',
      });
      f.authorization.findAccess.mockResolvedValueOnce(undefined);
      const input = {
        ...context,
        idempotencyKey: 'binding-authority',
        request: {
          manifest: boundManifest,
          bindings,
          ...(operation === 'import'
            ? {
                name: 'Imported',
                expectedCompatibilityFingerprint: fingerprint,
              }
            : {}),
        },
      };
      await expect(f[operation].execute(input)).rejects.toMatchObject({
        code: 'resource.not_found',
      });
      expect(f.authorization.findAccess).toHaveBeenCalledTimes(2);
      expect(f.persistence.previewWorkflowImport).not.toHaveBeenCalled();
      expect(f.persistence.importWorkflow).not.toHaveBeenCalled();
    },
  );
  it.each(['viewer', 'operator', 'builder', 'owner'] as const)(
    'permits reviewed export with read authority for %s',
    async (role) => {
      const f = fixture(role);
      await expect(
        f.export.execute({
          ...context,
          workflowId,
          request: {
            source: { kind: 'draft' },
            reviewedGraphDigest: 'a'.repeat(64),
          },
          representationTag: tag,
        }),
      ).resolves.toEqual(manifest);
      expect(f.persistence.exportWorkflow).toHaveBeenCalledWith({
        workspaceId,
        workflowId,
        actorId,
        requestId: 'portable-request',
        source: { kind: 'draft' },
        reviewedGraphDigest: 'a'.repeat(64),
        representationTag: tag,
      });
    },
  );
  it('never substitutes version sources or forwards irrelevant draft tags', async () => {
    const f = fixture();
    await f.export.execute({
      ...context,
      workflowId,
      request: {
        source: { kind: 'version', versionId: workflowId },
        reviewedGraphDigest: 'a'.repeat(64),
      },
      representationTag: tag,
    });
    expect(f.persistence.exportWorkflow.mock.calls[0]?.[0]).not.toHaveProperty(
      'representationTag',
    );
  });
  it.each(['viewer', 'operator'] as const)(
    'denies preview and creation for %s',
    async (role) => {
      const f = fixture(role);
      await expect(
        f.preview.execute({ ...context, request: { manifest, bindings: [] } }),
      ).rejects.toThrow();
      await expect(
        f.import.execute({
          ...context,
          idempotencyKey: 'key',
          request: {
            manifest,
            bindings: [],
            name: 'Imported',
            expectedCompatibilityFingerprint: fingerprint,
          },
        }),
      ).rejects.toThrow();
      expect(f.persistence.previewWorkflowImport).not.toHaveBeenCalled();
      expect(f.persistence.importWorkflow).not.toHaveBeenCalled();
    },
  );
  it('forwards exact import fingerprint, bindings, normalized name, key and cancellation on repeated explicit commands', async () => {
    const f = fixture('builder');
    const signal = new AbortController().signal;
    const input = {
      ...context,
      signal,
      idempotencyKey: 'retained-key',
      request: {
        manifest,
        bindings: [],
        name: '  Imported  ',
        expectedCompatibilityFingerprint: fingerprint,
      },
    };
    await f.import.execute(input);
    await f.import.execute(input);
    expect(f.persistence.importWorkflow).toHaveBeenCalledTimes(2);
    expect(f.persistence.importWorkflow.mock.calls[0]?.[0]).toEqual(
      f.persistence.importWorkflow.mock.calls[1]?.[0],
    );
    expect(f.persistence.importWorkflow).toHaveBeenCalledWith({
      workspaceId,
      actorId,
      requestId: 'portable-request',
      signal,
      idempotencyKey: 'retained-key',
      manifest,
      bindings: [],
      name: 'Imported',
      expectedCompatibilityFingerprint: fingerprint,
    });
  });
  it('sanitizes unknown keys rather than publishing uploaded property names in schema diagnostics', async () => {
    const f = fixture();
    await expect(
      f.preview.execute({
        ...context,
        request: {
          manifest,
          bindings: [],
          'sensitive-secret-key': 'sensitive-value',
        },
      }),
    ).rejects.toEqual({
      code: 'request.invalid',
      safeDetail: 'The portable workflow request is invalid.',
    });
    expect(f.persistence.previewWorkflowImport).not.toHaveBeenCalled();
  });
});
