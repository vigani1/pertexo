import { describe, expect, it } from 'vitest';
import {
  workflowImportPreviewRequestSchema,
  workflowImportRequestSchema,
  workflowPortableManifestSchema,
} from '../../src/schemas/workflows/portability.js';
import {
  workflowSummaryResponseSchema,
  workflowTemplateOriginProjectionQuerySchema,
  workflowTemplateOriginProjectionResponseSchema,
} from '../../src/schemas/workflows/authoring.js';
import {
  workflowPortabilityClientContract,
  workflowPortabilityOpenApiDocument,
} from '../../src/server.js';

describe('portable workflow public HTTP contract', () => {
  const manifest = {
    format: 'pertexo.workflow',
    formatVersion: 1,
    graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
    requirements: {
      definitions: [],
    },
    connectionSlots: [],
  };
  const origin = {
    schemaVersion: 1,
    templateId: 'controlled-http-notification',
    templateVersion: 1,
    baseManifestDigest: 'a'.repeat(64),
  };
  it('adds origin outside unchanged strict manifest V1 without defaulting old requests', () => {
    const old = { manifest, bindings: [] };
    expect(workflowImportPreviewRequestSchema.parse(old)).toEqual(old);
    expect(
      workflowImportPreviewRequestSchema.parse({
        ...old,
        templateOrigin: origin,
      }),
    ).toEqual({ ...old, templateOrigin: origin });
    expect(
      workflowImportRequestSchema.parse({
        ...old,
        templateOrigin: origin,
        name: 'Example',
        expectedCompatibilityFingerprint: `wf-compat:v1:sha256:${'b'.repeat(64)}`,
      }).templateOrigin,
    ).toEqual(origin);
    expect(
      workflowPortableManifestSchema.safeParse({
        ...manifest,
        templateOrigin: origin,
      }).success,
    ).toBe(false);
  });
  it.each([
    null,
    { ...origin, schemaVersion: 2 },
    { ...origin, templateVersion: 0 },
    { ...origin, templateVersion: 2_147_483_648 },
    { ...origin, templateId: 'Unreviewed ID' },
    { ...origin, baseManifestDigest: 'A'.repeat(64) },
    { ...origin, creationCommandDigest: 'b'.repeat(64) },
    { ...origin, derivation: 'direct' },
  ])(
    'rejects malformed or server-derived request origin %#',
    (templateOrigin) => {
      expect(
        workflowImportPreviewRequestSchema.safeParse({
          manifest,
          bindings: [],
          templateOrigin,
        }).success,
      ).toBe(false);
    },
  );
  it('keeps default summary strict and requires an explicit authoritative origin projection', () => {
    expect(
      workflowTemplateOriginProjectionQuerySchema.parse({
        include: 'templateOrigin',
      }),
    ).toEqual({ include: 'templateOrigin' });
    for (const query of [
      {},
      { include: 'other' },
      { include: ['templateOrigin'] },
      { include: 'templateOrigin', extra: true },
    ])
      expect(
        workflowTemplateOriginProjectionQuerySchema.safeParse(query).success,
      ).toBe(false);
    const workflow = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Example',
      nameRevision: 1,
      lifecycleStatus: 'active',
      lifecycleRevision: 1,
      activationStatus: 'inactive',
      publishedVersionId: null,
      createdAt: '2026-10-02T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    };
    expect(
      workflowSummaryResponseSchema.safeParse({
        workflow,
        templateOrigin: null,
      }).success,
    ).toBe(false);
    expect(
      workflowTemplateOriginProjectionResponseSchema.safeParse({ workflow })
        .success,
    ).toBe(false);
    expect(
      workflowTemplateOriginProjectionResponseSchema.parse({
        workflow,
        templateOrigin: null,
      }),
    ).toEqual({ workflow, templateOrigin: null });
    expect(
      workflowTemplateOriginProjectionResponseSchema.parse({
        workflow,
        templateOrigin: {
          ...origin,
          creationCommandDigest: 'b'.repeat(64),
          derivation: 'inherited',
        },
      }).templateOrigin?.derivation,
    ).toBe('inherited');
  });
  it('owns authenticated CSRF export and preview plus an idempotent creation command', () => {
    const paths = workflowPortabilityOpenApiDocument.paths;
    for (const path of Object.values(paths)) {
      expect(path.post.security).toEqual([{ cookieSession: [] }]);
      expect(path.post.parameters).toContainEqual(
        expect.objectContaining({ name: 'x-csrf-token', in: 'header' }),
      );
    }
    const create = paths['/v1/workspaces/{workspaceId}/workflows/import'].post;
    expect(create.parameters).toContainEqual(
      expect.objectContaining({ name: 'Idempotency-Key', required: true }),
    );
    expect(create.responses['201'].headers).toHaveProperty('Location');
    expect(create.responses['201'].headers['Cache-Control'].schema.const).toBe(
      'private, no-store',
    );
    const exported =
      paths['/v1/workspaces/{workspaceId}/workflows/{workflowId}/export'].post;
    expect(
      exported.responses['200'].headers['Content-Disposition'].schema.const,
    ).toBe('attachment; filename="workflow.pertexo.json"');
    expect(exported.parameters).toContainEqual(
      expect.objectContaining({ name: 'If-Match', required: false }),
    );
    expect(workflowPortabilityClientContract.schemas).toHaveProperty(
      'WorkflowPortableManifest',
    );
  });
});
