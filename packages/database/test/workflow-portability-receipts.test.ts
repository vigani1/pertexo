import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalWorkflowPortableJson,
  WORKFLOW_PORTABILITY_LIMITS,
} from '@pertexo/workflow-model/portability-contract';
import {
  projectWorkflowPortableManifest,
  type WorkflowPortabilityCatalog,
} from '@pertexo/workflow-model/portability';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model/graph';
import { workflowImportCommandIdentity } from '../src/authoring/workflow-portability-receipts.js';

describe('portable import receipt identity boundary', () => {
  it('admits the exact public 2MiB boundary without duplicating internal actor/workspace bytes', () => {
    const fingerprint = `node-compat:v1:sha256:${'1'.repeat(64)}`;
    const catalog: WorkflowPortabilityCatalog = {
      fingerprint,
      definitions: [
        {
          key: 'test.provider',
          version: 1,
          configVersion: 1,
          slots: [
            { slot: 'account', providerKey: 'http', authType: 'http_headers' },
          ],
          validateConfig: () => true,
        },
      ],
      selectionFingerprint: () => `node-select:v1:sha256:${'2'.repeat(64)}`,
    };
    const nodes = Array.from({ length: 1000 }, (_, index) => ({
      id: `${String(index).padStart(4, '0')}-${'n'.repeat(520)}`,
      definition: { key: 'test.provider', version: 1 },
      configVersion: 1,
      config: { literal: '' },
      inputMappings: {},
      connectionRefs: {},
      position: { x: 0, y: 0 },
    }));
    const graph = { schemaVersion: 1, nodes, edges: [], settings: {} };
    const bindings = nodes.map(({ id }) => ({
      nodeId: id,
      slot: 'account',
      connectionId: randomUUID(),
    }));
    const manifest = projectWorkflowPortableManifest(
      parseWorkflowGraphDraft(graph),
      catalog,
    );
    const publicBody = {
      manifest,
      bindings,
      name: 'Boundary import',
      expectedCompatibilityFingerprint: fingerprint,
    };
    const remaining =
      WORKFLOW_PORTABILITY_LIMITS.bytes -
      Buffer.byteLength(canonicalWorkflowPortableJson(publicBody));
    expect(remaining).toBeGreaterThan(0);
    const first = nodes[0];
    if (first === undefined) throw new Error('Expected boundary graph node');
    first.config.literal = 'x'.repeat(remaining);
    const boundedManifest = projectWorkflowPortableManifest(
      parseWorkflowGraphDraft(graph),
      catalog,
    );
    const body = { ...publicBody, manifest: boundedManifest };
    const canonical = canonicalWorkflowPortableJson(body);
    expect(Buffer.byteLength(canonical)).toBe(
      WORKFLOW_PORTABILITY_LIMITS.bytes,
    );
    const identity = workflowImportCommandIdentity({
      ...body,
      workspaceId: randomUUID(),
      actorId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    expect(identity.command).toBe(canonical);
    expect(identity.requestHash).toBe(
      createHash('sha256').update(canonical).digest('hex'),
    );
    expect(
      Object.keys(
        JSON.parse(identity.command) as Record<string, unknown>,
      ).sort(),
    ).toEqual([
      'bindings',
      'expectedCompatibilityFingerprint',
      'manifest',
      'name',
    ]);
  });
});
