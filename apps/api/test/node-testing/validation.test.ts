import { randomUUID } from 'node:crypto';

import { PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE } from '@pertexo/node-catalog';
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
          path: expect.stringMatching(/^\$\.config/u),
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
    expect(result.issues.length).toBeLessThanOrEqual(100);
  });

  it('fails closed for missing, ambiguous, and release-unknown definitions', async () => {
    const missing = await prepareNodeValidation({
      graph: graph(),
      nodeId: 'missing',
      release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
    });
    expect(missing.issues).toEqual([
      expect.objectContaining({ code: 'node.not_found_or_ambiguous' }),
    ]);

    const unknown = await prepareNodeValidation({
      graph: graph({ definition: { key: 'future.node', version: 1 } }),
      nodeId: 'http',
      release: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
    });
    expect(unknown.issues).toEqual([
      expect.objectContaining({ code: 'node.definition_unavailable' }),
    ]);
  });
});
