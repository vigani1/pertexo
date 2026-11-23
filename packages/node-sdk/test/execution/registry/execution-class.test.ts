import { NODE_JSON_LIMITS } from '../../../src/values/bounded-json.validation.js';
import { describe, expect, it } from 'vitest';

import {
  executorManifestFor,
  nodeManifestSchema,
  type NodeManifest,
} from '../../../src/definitions/catalog.js';
import {
  createNodeRegistry,
  createInlineNodeRegistry,
  type NodeRegistryOptions,
  type CoreNodeExecutorRegistration,
} from '../../../src/server.js';
import {
  configSchema,
  executorRegistration,
  manifest,
  objectSchema,
} from './registry.fixture.js';

const inlineManifest = {
  ...manifest,
  capabilities: [],
  execution: 'inline',
} as const satisfies NodeManifest;

const executeInline: NonNullable<
  CoreNodeExecutorRegistration['executeInline']
> = (invocation) => ({
  kind: 'succeeded',
  output: { ...invocation, fields: Object.keys(invocation) },
});

function options(selected: NodeManifest = inlineManifest): NodeRegistryOptions {
  return {
    catalog: {
      definitions: [selected],
      executors: [executorManifestFor(selected)],
      policies: selected.policyReferences,
    },
    definitions: [],
    executors: [],
    core: {
      definitions: [
        {
          manifest: selected,
          configSchema,
          inputSchema: objectSchema,
          outputSchema: objectSchema,
        },
      ],
      executors: [{ ...executorRegistration(), executeInline }],
    },
  };
}

describe('versioned execution class registration', () => {
  it('keeps a missing class absent and accepts an explicit attempt class', () => {
    expect(nodeManifestSchema.parse(manifest)).toStrictEqual(manifest);
    expect(
      nodeManifestSchema.parse({ ...manifest, execution: 'attempt' }),
    ).toHaveProperty('execution', 'attempt');
    expect(
      nodeManifestSchema.safeParse({ ...manifest, execution: 'queued' })
        .success,
    ).toBe(false);
  });

  it('pairs an explicit attempt registration with a legacy catalog manifest', () => {
    const attempt = options({ ...manifest, execution: 'attempt' });
    expect(() =>
      createNodeRegistry({ ...attempt, catalog: options(manifest).catalog }),
    ).not.toThrow();
  });

  it('refuses inline declarations from the attempt-only source even without integration metadata', () => {
    const { core, ...registry } = options();
    expect(() =>
      createNodeRegistry({
        ...registry,
        definitions: core?.definitions ?? [],
        executors: core?.executors ?? [],
      }),
    ).toThrow(/inline execution requires a core registration/u);
  });

  it('refuses an inline definition when its matching executor is outside the core source', () => {
    const { core, ...registry } = options();
    expect(() =>
      createNodeRegistry({
        ...registry,
        executors: core?.executors ?? [],
        core: { definitions: core?.definitions ?? [], executors: [] },
      }),
    ).toThrow(/has no core attempt fallback/u);
  });

  it('refuses a registry definition with a different execution class than its catalog version', () => {
    const registry = options();
    const attempt = options({ ...inlineManifest, execution: 'attempt' });
    expect(() =>
      createNodeRegistry({ ...attempt, catalog: registry.catalog }),
    ).toThrow(/does not match the catalog/u);
  });

  it('refuses a mismatched definition and executor pairing', () => {
    const registry = options();
    expect(() =>
      createNodeRegistry({
        ...registry,
        catalog: {
          ...registry.catalog,
          executors: [
            {
              ...executorManifestFor(inlineManifest),
              definitions: [{ ...manifest.definition, version: 2 }],
            },
          ],
        },
      }),
    ).toThrow(/invalid node catalog/u);
  });

  it.each([
    ['retry safety', { retryClass: 'unsafe' }],
    ['connections', { connectionRequirements: ['provider'] }],
    ['credentials', { credentialRequirements: ['provider'] }],
    ['capabilities', { capabilities: ['external_http'] }],
  ] as const)(
    'refuses inline definitions with incompatible %s',
    (_, fields) => {
      expect(() =>
        createNodeRegistry(options({ ...inlineManifest, ...fields })),
      ).toThrow(
        /requires safe retries and zero credential requirements, connection slots or capabilities/u,
      );
    },
  );

  it('refuses a dispatch-aware attempt fallback', () => {
    expect(() =>
      createNodeRegistry(options({ ...inlineManifest, executorAbi: 2 })),
    ).toThrow(/dispatch-aware executor/u);
  });

  it('receives only config, mapped input and the injected clock snapshot', () => {
    const registry = createInlineNodeRegistry(options());
    expect(
      registry.executeInline({
        definition: inlineManifest.definition,
        executor: inlineManifest.executor,
        config: {},
        input: { message: 'hello' },
        now: 123,
      }),
    ).toEqual({
      kind: 'succeeded',
      output: {
        config: {},
        input: { message: 'hello' },
        now: 123,
        fields: ['config', 'input', 'now'],
      },
    });
  });

  it('refuses malformed inline config and input before executing the kernel', () => {
    const registry = createInlineNodeRegistry(options());
    const request = {
      definition: inlineManifest.definition,
      executor: inlineManifest.executor,
      now: 123,
    };
    expect(() =>
      registry.executeInline({
        ...request,
        config: { unknown: true },
        input: {},
      }),
    ).toThrow(/configuration does not match its versioned schema/u);
    expect(() =>
      registry.executeInline({ ...request, config: {}, input: 'unexpected' }),
    ).toThrow(/input does not match its versioned schema/u);
  });

  it('validates inline input even when a caller supplies a delivery admission marker', () => {
    const registry = createInlineNodeRegistry(options());
    const request = {
      definition: inlineManifest.definition,
      executor: inlineManifest.executor,
      config: {},
      input: 'unexpected',
      now: 123,
      inputAdmission: 'persisted_agent',
    };
    expect(() => registry.executeInline(request)).toThrow(
      /input does not match its versioned schema/u,
    );
  });

  it('refuses inline results outside the bounded output envelope', () => {
    const registered = options();
    const registry = createInlineNodeRegistry({
      ...registered,
      core: {
        definitions: registered.core?.definitions ?? [],
        executors: [
          {
            ...executorRegistration(),
            executeInline: () => ({
              kind: 'succeeded',
              output: { value: 'x'.repeat(NODE_JSON_LIMITS.bytes) },
            }),
          },
        ],
      },
    });
    expect(() =>
      registry.executeInline({
        definition: inlineManifest.definition,
        executor: inlineManifest.executor,
        config: {},
        input: {},
        now: 123,
      }),
    ).toThrow(/output does not match its versioned schema/u);
  });

  it('requires a synchronous binding for an inline definition', () => {
    const registry = options();
    expect(() =>
      createNodeRegistry({
        ...registry,
        core: {
          definitions: registry.core?.definitions ?? [],
          executors: [executorRegistration()],
        },
      }),
    ).toThrow(/has no synchronous core executor/u);
  });

  it('executes a trusted inline definition through its pinned attempt fallback', async () => {
    const registry = createNodeRegistry(options());
    await expect(
      registry.execute({
        definition: inlineManifest.definition,
        executor: inlineManifest.executor,
        config: {},
        input: {},
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: {} });
  });
});
