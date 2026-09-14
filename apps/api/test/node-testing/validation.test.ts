import { randomUUID } from 'node:crypto';

import { PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE } from '@pertexo/node-catalog';
import { nodeValidationResponseSchema } from '@pertexo/contracts/node-testing';
import { describe, expect, it } from 'vitest';

import { prepareNodeValidation } from '../../src/node-testing/validation.js';

function graph(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: 'http',
        definition: { key: 'http.request', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {
          method: 'POST',
          url: 'https://provider.example.test/resource',
          headers: {},
          timeoutMillis: 1_000,
          maxRedirects: 1,
          maxResponseBytes: 1_024,
          inlineResponseBytes: 512,
        },
        inputMappings: {
          body: { kind: 'run_input', path: '$.body' },
        },
        connectionRefs: { http_headers: randomUUID() },
        ...overrides,
      },
    ],
    edges: [],
    settings: {},
  } as const;
}

describe('pure node preview validation', () => {
  it('resolves sample mappings and derives disclosure without an execution dependency', async () => {
    const result = await prepareNodeValidation({
      graph: graph(),
      nodeId: 'http',
      release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      sampleInput: {
        body: { encoding: 'utf8', value: 'hello' },
      },
    });
    expect(result).toMatchObject({
      definition: { key: 'http.request', version: 1 },
      executor: { key: 'http.request', version: 1 },
      integration: { providerKey: 'http', operationKey: 'request' },
      disclosure: {
        sideEffectClass: 'unsafe',
        mayContactProvider: true,
        mayCauseExternalSideEffect: true,
        dryRun: 'not_supported',
      },
      issues: [],
      resolvedInput: {
        body: { encoding: 'utf8', value: 'hello' },
      },
    });
  });

  it.each([0, 999])(
    'reports incompatible selected config version %i at the owning field',
    async (configVersion) => {
      const result = await prepareNodeValidation({
        graph: graph({ configVersion }),
        nodeId: 'http',
        release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
        sampleInput: {
          body: { encoding: 'utf8', value: 'hello' },
        },
      });

      expect(result.issues).toContainEqual({
        path: '$.configVersion',
        code: 'node.config_version_incompatible',
        message: 'Selected node configuration version is incompatible',
      });
    },
  );

  it('returns bounded field-addressed config, mapping, input, and connection issues', async () => {
    const result = await prepareNodeValidation({
      graph: graph({
        config: { method: 'GET', url: 'http://127.0.0.1' },
        connectionRefs: { unexpected: randomUUID() },
      }),
      nodeId: 'http',
      release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      sampleInput: {},
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'node.config_invalid',
        }),
        expect.objectContaining({
          path: '$.connectionRefs.http_headers',
          code: 'node.connection_required',
        }),
        expect.objectContaining({
          path: '$.connectionRefs.unexpected',
          code: 'node.connection_unexpected',
        }),
        expect.objectContaining({
          path: '$.inputMappings.body',
          code: 'node.mapping_missing',
        }),
      ]),
    );
    expect(
      result.issues.some(
        (issue) =>
          issue.code === 'node.config_invalid' &&
          issue.path.startsWith('$.config'),
      ),
    ).toBe(true);
    expect(result.issues.length).toBeLessThanOrEqual(100);
  });

  it('reports a missing selected node independently', async () => {
    const missing = await prepareNodeValidation({
      graph: graph(),
      nodeId: 'missing',
      release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
    });
    expect(missing.issues).toEqual([
      expect.objectContaining({ code: 'node.not_found_or_ambiguous' }),
    ]);
  });

  it('reports a duplicate selected ID across nested bodies', async () => {
    const selected = graph().nodes[0];
    const ambiguous = await prepareNodeValidation({
      graph: {
        ...graph(),
        nodes: [
          selected,
          {
            ...selected,
            id: 'loop',
            structured: {
              kind: 'for_each',
              maxIterations: 2,
              maxConcurrency: 1,
              body: {
                schemaVersion: 1,
                nodes: [selected],
                edges: [],
                settings: {},
                inputPorts: [],
                outputPorts: [],
              },
            },
          },
        ],
      },
      nodeId: 'http',
      release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
    });

    expect(ambiguous.issues).toEqual([
      {
        path: '$.nodeId',
        code: 'node.not_found_or_ambiguous',
        message: 'Selected node does not identify exactly one draft node',
      },
    ]);
  });

  it('reports an unavailable definition independently', async () => {
    const unknown = await prepareNodeValidation({
      graph: graph({ definition: { key: 'future.node', version: 1 } }),
      nodeId: 'http',
      release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
    });

    expect(unknown.issues).toEqual([
      expect.objectContaining({ code: 'node.definition_unavailable' }),
    ]);
  });

  it('distinguishes missing and unexpected connection slots', async () => {
    const result = await prepareNodeValidation({
      graph: graph({ connectionRefs: { extra: randomUUID() } }),
      nodeId: 'http',
      release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
    });

    expect(
      result.issues.filter(({ code }) => code.includes('connection')),
    ).toEqual([
      {
        path: '$.connectionRefs.http_headers',
        code: 'node.connection_required',
        message: 'Required connection reference is missing or invalid',
      },
      {
        path: '$.connectionRefs.extra',
        code: 'node.connection_unexpected',
        message: 'Connection reference is not declared by this definition',
      },
    ]);
  });

  it('distinguishes missing and failed input mappings', async () => {
    const missing = await prepareNodeValidation({
      graph: graph(),
      nodeId: 'http',
      release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      sampleInput: {},
    });
    const failed = await prepareNodeValidation({
      graph: graph({
        inputMappings: {
          body: {
            kind: 'expression',
            language: 'jsonata',
            expression: '$',
            policyVersion: 1,
          },
        },
      }),
      nodeId: 'http',
      release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      sampleInput: {},
      expressionEvaluator: {
        evaluate: () =>
          Promise.resolve({
            kind: 'error',
            code: 'evaluation_failed',
            message: 'x'.repeat(1_000),
          }),
      },
    });

    expect(missing.issues).toContainEqual(
      expect.objectContaining({
        path: '$.inputMappings.body',
        code: 'node.mapping_missing',
      }),
    );
    expect(failed.issues).toContainEqual(
      expect.objectContaining({
        path: '$.inputMappings.body',
        code: 'node.mapping_invalid',
      }),
    );
    expect(
      failed.issues.find(({ code }) => code === 'node.mapping_invalid')
        ?.message,
    ).toHaveLength(500);
  });

  it('reports resolved input schema failure independently', async () => {
    const result = await prepareNodeValidation({
      graph: graph({
        inputMappings: { body: { kind: 'literal', value: null } },
      }),
      nodeId: 'http',
      release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      sampleInput: {},
    });

    const inputIssue = result.issues.find(
      ({ code }) => code === 'node.input_invalid',
    );
    expect(inputIssue?.path).toMatch(/^\$\.resolvedInput/u);
  });

  it('defers prior-preview input without evaluating mappings or input schema', async () => {
    const result = await prepareNodeValidation({
      graph: graph(),
      nodeId: 'http',
      release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      deferInput: true,
    });

    expect(result).toMatchObject({ issues: [], resolvedInput: {} });
  });

  it('caps issues deterministically and bounds every public issue field', async () => {
    const connectionRefs: Record<string, string> = {
      ['a'.repeat(2_000)]: randomUUID(),
    };
    for (let index = 0; index < 105; index += 1)
      connectionRefs[`slot${String(index).padStart(3, '0')}`] = randomUUID();
    const result = await prepareNodeValidation({
      graph: graph({ connectionRefs }),
      nodeId: 'http',
      release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      sampleInput: {},
    });
    if (!('disclosure' in result))
      throw new Error('Expected a prepared preview with bounded issues');

    expect(result.issues).toHaveLength(100);
    expect(result.issues[0]?.code).toBe('node.connection_required');
    expect(result.issues[1]?.path).toHaveLength(1_024);
    expect(result.issues.at(-1)?.path).toBe('$.connectionRefs.slot097');
    for (const problem of result.issues) {
      expect(problem.path.length).toBeLessThanOrEqual(1_024);
      expect(problem.code.length).toBeLessThanOrEqual(128);
      expect(problem.message.length).toBeLessThanOrEqual(500);
    }
    expect(() =>
      nodeValidationResponseSchema.parse({
        mode: 'validate',
        valid: false,
        revision: 1,
        nodeId: 'http',
        issues: result.issues,
        disclosure: result.disclosure,
      }),
    ).not.toThrow();
  });
});
