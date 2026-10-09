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
import { canonicalJson } from '@pertexo/workflow-model/canonical-json';
import {
  parseWorkflowGraphDraft,
  WORKFLOW_GRAPH_LIMITS,
} from '@pertexo/workflow-model/graph';
import { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '@pertexo/workflow-model/graph-contract';
import { workflowImportCommandIdentity } from '../src/authoring/workflow-portability-receipts.js';

describe('portable import receipt identity boundary', () => {
  it('preserves absent-origin command bytes and includes exact origin in identity', () => {
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
        requirements: {
          definitions: [],
          selectionFingerprint: `node-select:v1:sha256:${'a'.repeat(64)}`,
        },
        connectionSlots: [],
      },
      bindings: [],
      name: 'Example',
      expectedCompatibilityFingerprint: `node-compat:v1:sha256:${'b'.repeat(64)}`,
    };
    const scope = {
      workspaceId: randomUUID(),
      actorId: randomUUID(),
      idempotencyKey: randomUUID(),
    };
    const old = workflowImportCommandIdentity({ ...scope, ...body });
    expect(old.command).toBe(canonicalWorkflowPortableJson(body));
    expect(old.requestHash).toBe(
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
    const direct = workflowImportCommandIdentity({
      ...scope,
      ...body,
      templateOrigin: origin,
    });
    expect(direct.command).toBe(
      canonicalWorkflowPortableJson({ ...body, templateOrigin: origin }),
    );
    expect(direct.requestHash).not.toBe(old.requestHash);
    for (const changed of [
      { ...origin, templateVersion: 2 },
      { ...origin, baseManifestDigest: 'd'.repeat(64) },
    ])
      expect(
        workflowImportCommandIdentity({
          ...scope,
          ...body,
          templateOrigin: changed,
        }).requestHash,
      ).not.toBe(direct.requestHash);
    expect(
      workflowImportCommandIdentity({
        ...scope,
        actorId: randomUUID(),
        ...body,
        templateOrigin: origin,
      }),
    ).toEqual(direct);
  });
  it('admits the largest valid import without duplicating internal actor/workspace bytes', () => {
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
    const nodes = Array.from(
      { length: WORKFLOW_GRAPH_LIMITS.nodes },
      (_, index) => ({
        id: String(index).padEnd(
          WORKFLOW_GRAPH_CONTRACT_LIMITS.identifierLength,
          'n',
        ),
        definition: { key: 'test.provider', version: 1 },
        configVersion: 1,
        config: { literal: '' },
        inputMappings: {},
        connectionRefs: {},
        position: { x: 0, y: 0 },
      }),
    );
    const graph = { schemaVersion: 1, nodes, edges: [], settings: {} };
    const bindings = nodes.map(({ id }) => ({
      nodeId: id,
      slot: 'account',
      connectionId: randomUUID(),
    }));
    const first = nodes[0];
    if (first === undefined) throw new Error('Expected boundary graph node');
    first.config.literal = 'x'.repeat(
      WORKFLOW_GRAPH_LIMITS.graphBytes -
        Buffer.byteLength(canonicalJson(graph)),
    );
    const manifest = projectWorkflowPortableManifest(
      parseWorkflowGraphDraft(graph),
      catalog,
    );
    const body = {
      manifest,
      bindings,
      name: 'Boundary import',
      expectedCompatibilityFingerprint: fingerprint,
    };
    const canonical = canonicalWorkflowPortableJson(body);
    expect(Buffer.byteLength(canonical)).toBeLessThanOrEqual(
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
