import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalWorkflowPortableJson } from '@pertexo/workflow-model';
import { workflowImportCommandDigest } from '../src/authoring/portability/store.js';

describe('workflow import command digest', () => {
  it('hashes the public command, including a template origin, but not who sent it', () => {
    const body = {
      manifest: {
        format: 'pertexo.workflow' as const,
        formatVersion: 1 as const,
        graph: {
          schemaVersion: 1 as const,
          nodes: [],
          edges: [],
          settings: {},
        },
        requirements: { definitions: [] },
        connectionSlots: [],
      },
      bindings: [],
      name: 'Example',
      expectedCompatibilityFingerprint: `wf-compat:v1:sha256:${'b'.repeat(64)}`,
    };
    const scope = {
      workspaceId: randomUUID(),
      actorId: randomUUID(),
      idempotencyKey: randomUUID(),
    };
    const plain = workflowImportCommandDigest({ ...scope, ...body });
    expect(plain).toBe(
      createHash('sha256')
        .update(canonicalWorkflowPortableJson(body))
        .digest('hex'),
    );
    const origin = {
      schemaVersion: 1 as const,
      templateId: 'example',
      templateVersion: 1,
      baseManifestDigest: 'c'.repeat(64),
    };
    const direct = workflowImportCommandDigest({
      ...scope,
      ...body,
      templateOrigin: origin,
    });
    expect(direct).not.toBe(plain);
    for (const changed of [
      { ...origin, templateVersion: 2 },
      { ...origin, baseManifestDigest: 'd'.repeat(64) },
    ])
      expect(
        workflowImportCommandDigest({
          ...scope,
          ...body,
          templateOrigin: changed,
        }),
      ).not.toBe(direct);
    expect(
      workflowImportCommandDigest({
        ...scope,
        actorId: randomUUID(),
        workspaceId: randomUUID(),
        ...body,
        templateOrigin: origin,
      }),
    ).toBe(direct);
  });
});
