import { describe, expect, it } from 'vitest';

import {
  CURATED_WORKFLOW_TEMPLATES,
  verifyCuratedTemplateManifest,
  validateCuratedTemplateSetupValue,
  workflowTemplateOriginRequestSchema,
  workflowTemplateOriginSchema,
  type CuratedWorkflowTemplate,
} from '../src/index.js';
import {
  canonicalWorkflowPortableJson,
  portableManifestDigest,
  workflowPortableManifestSchema,
} from '@pertexo/workflow-model/portability-contract';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing reviewed test fixture');
  return value;
}

function origin(descriptor: CuratedWorkflowTemplate) {
  return {
    schemaVersion: 1,
    templateId: descriptor.templateId,
    templateVersion: descriptor.templateVersion,
    baseManifestDigest: descriptor.baseManifestDigest,
  };
}

function setPath(
  value: unknown,
  path: readonly (string | number)[],
  replacement: unknown,
): void {
  let current = value as Record<string | number, unknown>;
  for (const key of path.slice(0, -1))
    current = current[key] as Record<string | number, unknown>;
  const key = required(path.at(-1));
  if (replacement === undefined) Reflect.deleteProperty(current, key);
  else current[key] = replacement;
}

describe('reviewed browser-safe curated templates', () => {
  it('pins all three complete strict V1 manifests and canonical digests', async () => {
    expect(CURATED_WORKFLOW_TEMPLATES.map((item) => item.templateId)).toEqual([
      'webhook-validation-routing',
      'schedule-bounded-batch',
      'controlled-http-notification',
    ]);
    for (const descriptor of CURATED_WORKFLOW_TEMPLATES) {
      expect(descriptor.supportedProfile).toBe('validate_activation');
      expect(workflowPortableManifestSchema.parse(descriptor.manifest)).toEqual(
        descriptor.manifest,
      );
      expect(await portableManifestDigest(descriptor.manifest)).toBe(
        descriptor.baseManifestDigest,
      );
      expect(
        verifyCuratedTemplateManifest(descriptor.manifest, origin(descriptor)),
      ).toEqual({ ok: true, descriptor });
      expect(descriptor.setupTargets.length).toBeLessThanOrEqual(16);
      expect(Object.isFrozen(descriptor.manifest.graph.nodes[0]?.config)).toBe(
        true,
      );
    }
    expect(CURATED_WORKFLOW_TEMPLATES[0]?.setupTargets).toEqual([]);
    expect(CURATED_WORKFLOW_TEMPLATES[1]?.setupTargets).toEqual([]);
    expect(CURATED_WORKFLOW_TEMPLATES[2]?.setupTargets).toEqual([
      {
        nodeId: 'controlled-http',
        location: 'config',
        key: 'url',
        valueKind: 'curated_https_endpoint_v1',
      },
      {
        nodeId: 'slack-notification',
        location: 'literalInput',
        key: 'channelId',
        valueKind: 'slack_channel_id',
      },
    ]);
  });

  it('bounds strict request and persisted origin without server-derived client fields', () => {
    const descriptor = required(CURATED_WORKFLOW_TEMPLATES[0]);
    const request = origin(descriptor);
    const persisted = {
      ...request,
      creationCommandDigest: 'a'.repeat(64),
      derivation: 'direct',
    };
    expect(workflowTemplateOriginRequestSchema.safeParse(request).success).toBe(
      true,
    );
    expect(
      workflowTemplateOriginRequestSchema.safeParse(persisted).success,
    ).toBe(false);
    expect(workflowTemplateOriginSchema.safeParse(persisted).success).toBe(
      true,
    );
    expect(
      new TextEncoder().encode(canonicalWorkflowPortableJson(persisted))
        .byteLength,
    ).toBeLessThanOrEqual(512);
    for (const patch of [
      { schemaVersion: 2 },
      { templateId: '' },
      { templateId: 'A-b' },
      { templateId: 'a--b' },
      { templateId: 'é' },
      { templateId: 'a'.repeat(65) },
      { templateVersion: 0 },
      { templateVersion: 2_147_483_648 },
      { templateVersion: 1.1 },
      { baseManifestDigest: 'A'.repeat(64) },
      { extra: true },
    ])
      expect(
        workflowTemplateOriginRequestSchema.safeParse({ ...request, ...patch })
          .success,
      ).toBe(false);
    expect(workflowTemplateOriginRequestSchema.safeParse(null).success).toBe(
      false,
    );
    expect(
      workflowTemplateOriginSchema.safeParse({
        ...persisted,
        derivation: 'copied',
      }).success,
    ).toBe(false);
    expect(
      workflowTemplateOriginSchema.safeParse({
        ...persisted,
        sourceWorkflowId: 'private',
      }).success,
    ).toBe(false);
  });

  it('admits only the two typed literal changes without changing caller or reviewed assets', () => {
    const descriptor = required(CURATED_WORKFLOW_TEMPLATES[2]);
    const configured = structuredClone(descriptor.manifest);
    const http = required(
      configured.graph.nodes.find((node) => node.id === 'controlled-http'),
    );
    const slack = required(
      configured.graph.nodes.find((node) => node.id === 'slack-notification'),
    );
    Object.assign(http.config, {
      url: 'https://destination.example.test/data?limit=2',
    });
    Object.assign(slack.inputMappings, {
      channelId: { kind: 'literal', value: 'D123ABC' },
    });
    const before = canonicalWorkflowPortableJson(configured);
    expect(
      verifyCuratedTemplateManifest(configured, origin(descriptor)).ok,
    ).toBe(true);
    expect(canonicalWorkflowPortableJson(configured)).toBe(before);
    expect(http.config.url).toBe(
      'https://destination.example.test/data?limit=2',
    );
    expect(
      descriptor.manifest.graph.nodes.find(
        (node) => node.id === 'controlled-http',
      )?.config.url,
    ).toBe('https://example.test/curated-demo');
  });

  it.each([
    ['node ID', ['graph', 'nodes', 0, 'id'], 'changed'],
    ['position', ['graph', 'nodes', 0, 'position', 'x'], 1],
    [
      'expression',
      ['graph', 'nodes', 2, 'inputMappings', 'condition', 'expression'],
      'nodeOutputs."controlled-http".status = 200 ',
    ],
    [
      'mapping kind',
      ['graph', 'nodes', 3, 'inputMappings', 'channelId'],
      { kind: 'run_input', path: '$' },
    ],
    ['extra config', ['graph', 'nodes', 1, 'config', 'extra'], true],
    ['missing target', ['graph', 'nodes', 1, 'config', 'url'], undefined],
    ['missing node', ['graph', 'nodes', 1], undefined],
    ['edge', ['graph', 'edges', 0, 'id'], 'changed'],
    ['settings', ['graph', 'settings', 'maxRunDurationMs'], 1],
    ['requirements', ['requirements', 'definitions', 0, 'version'], 2],
    ['slot', ['connectionSlots', 0, 'slot'], 'changed'],
    [
      'bound connection',
      ['graph', 'nodes', 1, 'connectionRefs', 'http_headers'],
      'private',
    ],
    [
      'invalid channel',
      ['graph', 'nodes', 3, 'inputMappings', 'channelId', 'value'],
      'private',
    ],
    [
      'credential URL',
      ['graph', 'nodes', 1, 'config', 'url'],
      'https://example.test?Token=private',
    ],
    ['unknown envelope member', ['templateOrigin'], {}],
  ] as const)('rejects non-reviewed %s changes', (_label, path, value) => {
    const descriptor = required(CURATED_WORKFLOW_TEMPLATES[2]);
    const configured = structuredClone(descriptor.manifest);
    setPath(configured, path, value);
    const result = verifyCuratedTemplateManifest(
      configured,
      origin(descriptor),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('rejects reordered and duplicate nodes', () => {
    const descriptor = required(CURATED_WORKFLOW_TEMPLATES[2]);
    for (const nodes of [
      [...descriptor.manifest.graph.nodes].reverse(),
      [
        ...descriptor.manifest.graph.nodes,
        required(descriptor.manifest.graph.nodes[1]),
      ],
    ]) {
      const manifest = {
        ...descriptor.manifest,
        graph: { ...descriptor.manifest.graph, nodes },
      };
      expect(
        verifyCuratedTemplateManifest(manifest, origin(descriptor)).ok,
      ).toBe(false);
    }
  });

  it('rejects edits in nested bodies and literal demo data', () => {
    const descriptor = required(CURATED_WORKFLOW_TEMPLATES[1]);
    const configured = structuredClone(descriptor.manifest);
    const body = configured.graph.nodes[1]?.structured?.body;
    Object.assign(required(required(body).nodes[0]).position, { x: 2 });
    expect(
      verifyCuratedTemplateManifest(configured, origin(descriptor)).ok,
    ).toBe(false);
    const changedItems = structuredClone(descriptor.manifest);
    Object.assign(required(changedItems.graph.nodes[1]).inputMappings, {
      items: { kind: 'literal', value: [] },
    });
    expect(
      verifyCuratedTemplateManifest(changedItems, origin(descriptor)).ok,
    ).toBe(false);
  });

  it('rejects forged origin, hostile JSON, null, depth and bytes without leaking data', () => {
    const descriptor = required(CURATED_WORKFLOW_TEMPLATES[0]);
    for (const request of [
      null,
      { ...origin(descriptor), templateVersion: 2 },
      { ...origin(descriptor), baseManifestDigest: '0'.repeat(64) },
    ])
      expect(
        verifyCuratedTemplateManifest(descriptor.manifest, request).ok,
      ).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: unknown = {};
    for (let i = 0; i < 300; i++) deep = { deep };
    for (const manifest of [
      null,
      cyclic,
      deep,
      { private: 'x'.repeat(2_097_153) },
    ])
      expect(
        verifyCuratedTemplateManifest(manifest, origin(descriptor)).ok,
      ).toBe(false);
  });

  it('validates setup without normalization or literal disclosure', () => {
    for (const value of [
      'https://example.test/path',
      'https://example.test/?safe=private',
    ])
      expect(
        validateCuratedTemplateSetupValue('curated_https_endpoint_v1', value)
          .ok,
      ).toBe(true);
    for (const value of [
      ' https://example.test ',
      'http://example.test',
      'https://user:private@example.test',
      'https://example.test#private',
      'https://example.test?%74oken=private',
      null,
    ]) {
      const result = validateCuratedTemplateSetupValue(
        'curated_https_endpoint_v1',
        value,
      );
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('private');
    }
  });
});
