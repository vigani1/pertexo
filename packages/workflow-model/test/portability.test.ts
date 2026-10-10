import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '../src/graph/contract.js';
import {
  canonicalWorkflowPortableJson,
  parsePortableJson,
  portableGraphDigest,
  portableManifestDigest,
  PortableJsonError,
  workflowPortableManifestSchema,
  WORKFLOW_PORTABILITY_LIMITS,
} from '../src/portability/contract.js';
import {
  inspectWorkflowPortableManifest,
  projectWorkflowPortableManifest,
  WorkflowPortabilityError,
  type WorkflowPortabilityCatalog,
} from '../src/portability/projection.js';

const catalog: WorkflowPortabilityCatalog = {
  definitions: ['core.set', 'core.foreach', 'http.request'].map((key) => ({
    key,
    version: 1,
    configVersion: 1,
    validateConfig: (config) => config.invalid === undefined,
    slots:
      key === 'http.request'
        ? [
            {
              slot: 'http_headers',
              providerKey: 'http',
              authType: 'http_headers',
            },
          ]
        : [],
  })),
};
const node = (
  id: string,
  key = 'core.set',
): WorkflowGraph['nodes'][number] => ({
  id,
  definition: { key, version: 1 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
  position: { x: 0, y: 0 },
});
const graph = (nodes: WorkflowGraph['nodes']): WorkflowGraph => ({
  nodes,
  edges: [],
  settings: {},
});
const connectionId = '11111111-1111-4111-8111-111111111111';

describe('portable raw JSON admission', () => {
  it.each([
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '[{"x":1,"x":2}]',
    '{"a":{"a":1,"a":2}}',
    '{',
    ']',
    '{"a":[}',
    '{"x":"unterminated}',
    '{"a":undefined}',
    '{"a":NaN}',
    '1e999',
    '{"a":true,}',
  ])(
    'rejects malformed or duplicate raw JSON without reflecting input: %s',
    (text) => {
      expect(() => parsePortableJson(text)).toThrow(PortableJsonError);
      try {
        parsePortableJson(text);
      } catch (error) {
        expect(String(error)).not.toContain(text);
      }
    },
  );
  it('handles repeated keys in different scopes and quoted structural punctuation', () => {
    expect(parsePortableJson('{"a":{"a":"{[,]}\\""},"b":{"a":2}}')).toEqual({
      a: { a: '{[,]}"' },
      b: { a: 2 },
    });
  });
  it('counts UTF-8 bytes and rejects depth before recursive parsing', () => {
    expect(() =>
      parsePortableJson(
        `"${'é'.repeat(WORKFLOW_PORTABILITY_LIMITS.bytes / 2)}"`,
      ),
    ).toThrow(PortableJsonError);
    expect(() =>
      parsePortableJson('['.repeat(257) + '0' + ']'.repeat(257)),
    ).toThrow(PortableJsonError);
    expect(
      parsePortableJson('['.repeat(255) + '0' + ']'.repeat(255)),
    ).toBeDefined();
  });
  it('bounds strings/large arrays even before JSON syntax is valid', () => {
    expect(() =>
      parsePortableJson(' '.repeat(WORKFLOW_PORTABILITY_LIMITS.bytes + 1)),
    ).toThrow(PortableJsonError);
    expect(() => canonicalWorkflowPortableJson(new Array(2_097_152))).toThrow(
      PortableJsonError,
    );
  });
  it('never invokes accessors, accepts cycles or non-plain prototypes', () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'graph', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return {};
      },
    });
    expect(() => canonicalWorkflowPortableJson(accessor)).toThrow(
      PortableJsonError,
    );
    expect(getterCalls).toBe(0);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalWorkflowPortableJson(cyclic)).toThrow(
      PortableJsonError,
    );
    expect(() => canonicalWorkflowPortableJson(new Date())).toThrow(
      PortableJsonError,
    );
    expect(() => canonicalWorkflowPortableJson({ value: undefined })).toThrow(
      PortableJsonError,
    );
  });
  it('canonicalizes only bounded own JSON data independent of object order', () => {
    expect(
      canonicalWorkflowPortableJson({ b: [false, null, -0], a: 'é' }),
    ).toBe('{"a":"é","b":[false,null,0]}');
    const original = parsePortableJson('{"__proto__":{"x":1}}');
    expect(canonicalWorkflowPortableJson(original)).toBe(
      '{"__proto__":{"x":1}}',
    );
    expect(Object.prototype).not.toHaveProperty('x');
  });
});

describe('portable authoring projection and rebinding', () => {
  it('preserves nested IDs, edge ports, settings, labels and dynamic expressions; strips only typed connections', async () => {
    const child = {
      ...node('child', 'http.request'),
      connectionRefs: { http_headers: connectionId },
      inputMappings: {
        body: {
          kind: 'expression' as const,
          language: 'jsonata' as const,
          expression: '$lookup(nodeOutputs, runInput.stepId).value',
        },
      },
      label: 'Reviewed private literal text is not automatically scrubbed',
      disabled: true,
    };
    const source = graph([
      {
        ...node('loop', 'core.foreach'),
        structured: {
          kind: 'for_each',
          maxIterations: 2,
          maxConcurrency: 1,
          body: {
            ...graph([child]),
            inputPorts: ['item'],
            outputPorts: ['result'],
          },
        },
      },
    ]);
    const before = canonicalWorkflowPortableJson(source);
    const manifest = projectWorkflowPortableManifest(source, catalog);
    expect(manifest.connectionSlots).toEqual([
      {
        nodeId: 'child',
        slot: 'http_headers',
        providerKey: 'http',
        authType: 'http_headers',
      },
    ]);
    const rebound = inspectWorkflowPortableManifest(
      manifest,
      [{ nodeId: 'child', slot: 'http_headers', connectionId }],
      catalog,
    );
    expect(rebound.issues).toEqual([]);
    expect(rebound.graph).toEqual(source);
    expect(canonicalWorkflowPortableJson(source)).toEqual(before);
    expect(canonicalWorkflowPortableJson(manifest)).not.toContain(connectionId);
    expect(await portableGraphDigest(source)).not.toEqual(
      await portableManifestDigest(manifest),
    );
    expect(
      await portableGraphDigest({
        settings: {},
        edges: [],
        nodes: source.nodes,
      }),
    ).toEqual(await portableGraphDigest(source));
  });
  it('does not pretend to scrub arbitrary literal strings', () => {
    const source = graph([
      {
        ...node('a'),
        inputMappings: {
          value: {
            kind: 'literal',
            value: 'private-value-under-an-innocent-key',
          },
        },
      },
    ]);
    expect(projectWorkflowPortableManifest(source, catalog).graph).toEqual(
      source,
    );
  });
  it('represents missing required source connections as explicit slots, with no implicit destination', () => {
    const manifest = projectWorkflowPortableManifest(
      graph([node('http', 'http.request')]),
      catalog,
    );
    const inspected = inspectWorkflowPortableManifest(manifest, [], catalog);
    expect(inspected.issues).toMatchObject([
      { code: 'connection_binding_required' },
    ]);
    expect(inspected.graph.nodes[0]?.connectionRefs).toEqual({});
  });
  it.each([
    'password_auth',
    'credential',
    'secret',
    'token',
    'api-key',
    'api_key',
  ])(
    'refuses credential-like literal keys without echoing values: %s',
    (key) => {
      expect(() =>
        projectWorkflowPortableManifest(
          graph([
            {
              ...node('a'),
              inputMappings: {
                value: {
                  kind: 'literal',
                  value: { nested: [{ [key]: 'never-echo-this' }] },
                },
              },
            },
          ]),
          catalog,
        ),
      ).toThrow(WorkflowPortabilityError);
    },
  );
  it('refuses unsafe config shapes, unknown definitions/config versions and unregistered slot references', () => {
    for (const changed of [
      { ...node('a'), config: { secret: 'private' } },
      { ...node('a'), config: { invalid: true } },
      { ...node('a'), configVersion: 2 },
      node('a', 'unknown'),
      { ...node('a'), connectionRefs: { forged: connectionId } },
    ])
      expect(() =>
        projectWorkflowPortableManifest(graph([changed]), catalog),
      ).toThrow(WorkflowPortabilityError);
  });
  it('rejects duplicate graph IDs before slot identity can be ambiguous', () => {
    expect(() =>
      projectWorkflowPortableManifest(graph([node('a'), node('a')]), catalog),
    ).toThrow(WorkflowPortabilityError);
  });
  it('rejects manifest metadata, unsupported formats and embedded tenant connection references', () => {
    const manifest = projectWorkflowPortableManifest(
      graph([node('http', 'http.request')]),
      catalog,
    );
    for (const changed of [
      { ...manifest, workspaceId: connectionId },
      { ...manifest, format: 'foreign' },
      {
        ...manifest,
        graph: graph([
          {
            ...node('http', 'http.request'),
            connectionRefs: { http_headers: connectionId },
          },
        ]),
      },
    ])
      expect(() =>
        inspectWorkflowPortableManifest(
          changed as typeof manifest,
          [],
          catalog,
        ),
      ).toThrow();
  });
  it('rejects added/missing/duplicate/changed requirement or slot declarations', () => {
    const manifest = projectWorkflowPortableManifest(
      graph([node('http', 'http.request')]),
      catalog,
    );
    for (const changed of [
      { ...manifest, connectionSlots: [] },
      {
        ...manifest,
        connectionSlots: [
          ...manifest.connectionSlots,
          ...manifest.connectionSlots,
        ],
      },
      {
        ...manifest,
        connectionSlots: manifest.connectionSlots.map((slot) => ({
          ...slot,
          providerKey: 'slack',
        })),
      },
      {
        ...manifest,
        requirements: { ...manifest.requirements, definitions: [] },
      },
      {
        ...manifest,
        requirements: {
          definitions: manifest.requirements.definitions.map((definition) => ({
            ...definition,
            configVersion: definition.configVersion + 1,
          })),
        },
      },
    ])
      expect(() =>
        inspectWorkflowPortableManifest(changed, [], catalog),
      ).toThrow(WorkflowPortabilityError);
  });
  it('rejects extra/duplicate binding occurrences while allowing explicit shared destination selection', () => {
    const manifest = projectWorkflowPortableManifest(
      graph([node('a', 'http.request'), node('b', 'http.request')]),
      catalog,
    );
    const a = { nodeId: 'a', slot: 'http_headers', connectionId };
    expect(() =>
      inspectWorkflowPortableManifest(manifest, [a, a], catalog),
    ).toThrow(WorkflowPortabilityError);
    expect(() =>
      inspectWorkflowPortableManifest(
        manifest,
        [{ ...a, nodeId: 'missing' }],
        catalog,
      ),
    ).toThrow(WorkflowPortabilityError);
    expect(
      inspectWorkflowPortableManifest(
        manifest,
        [a, { ...a, nodeId: 'b' }],
        catalog,
      ).issues,
    ).toEqual([]);
  });
  it('bounds aggregate graph and manifest requirements before catalog validation', () => {
    const manifest = projectWorkflowPortableManifest(graph([]), catalog);
    expect(() =>
      workflowPortableManifestSchema.parse({
        ...manifest,
        graph: graph(
          Array.from({ length: 1001 }, (_, index) => node(String(index))),
        ),
      }),
    ).toThrow();
    expect(() =>
      workflowPortableManifestSchema.parse({
        ...manifest,
        connectionSlots: Array.from({ length: 1001 }, () => ({
          nodeId: 'a',
          slot: 's',
          providerKey: 'p',
          authType: 't',
        })),
      }),
    ).toThrow();
    expect(() =>
      workflowPortableManifestSchema.parse({
        ...manifest,
        graph: graph([
          { ...node('a'), config: { value: 'x'.repeat(1_048_576) } },
        ]),
      }),
    ).toThrow();
  });
});
