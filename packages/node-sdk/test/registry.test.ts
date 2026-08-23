import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import {
  canonicalCompatibilityReleaseJson,
  boundedNodeJsonSchema,
  computeCompatibilityReleaseFingerprint,
  computeCompatibilitySelectionFingerprint,
  createRegistryReleaseSuccessor,
  createRegistryRelease,
  DEFINITION_LIFECYCLE_TRANSITIONS,
  EXECUTOR_LIFECYCLE_TRANSITIONS,
  generateSchemaDocument,
  nodeManifestSchema,
  registryReleaseSchema,
  type DefinitionIdentity,
  type ExecutorIdentity,
  type NodeManifest,
  type PolicyReference,
  TERMINATES_RUN_CAPABILITY,
} from '../src/release.js';
import {
  DefinitionNotFoundError,
  ExecutorNotFoundError,
  InvalidBoundedJsonError,
  NodeConfigValidationError,
  NodeExecutionAbortedError,
  NodeDispatchEvidenceError,
  NodeExecutionRuntimeRequiredError,
  NodeExecutorFailure,
  NodeInputValidationError,
  NodeOutputValidationError,
  NodeRegistryCompatibilityError,
  NODE_EXECUTION_LIMITS_V1,
  canonicalizeBoundedJson,
  createNodeRegistry,
  type NodeExecutorRegistration,
} from '../src/server.js';

const definition: DefinitionIdentity = Object.freeze({
  key: 'test.echo',
  version: 1,
});
const executor: ExecutorIdentity = Object.freeze({
  key: 'test.echo',
  version: 1,
});
const policy: PolicyReference = Object.freeze({
  key: 'test.policy',
  version: 1,
});

const manifest: NodeManifest = Object.freeze({
  capabilities: Object.freeze(['test']),
  configSchema: generateSchemaDocument(z.object({}).strict()),
  configVersion: 1,
  connectionRequirements: Object.freeze([]),
  credentialRequirements: Object.freeze([]),
  definition,
  family: 'transform',
  inputSchema: generateSchemaDocument(z.record(z.string(), z.json())),
  lifecycle: 'active',
  outputSchema: generateSchemaDocument(z.record(z.string(), z.json())),
  policyReferences: Object.freeze([policy]),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out']),
  }),
  resourceClass: 'cpu',
  retryClass: 'safe',
  schemaVersion: 1,
  executor,
});

const executorRegistration = (
  identity: ExecutorIdentity = executor,
): NodeExecutorRegistration => ({
  abiVersion: 1,
  definitions: Object.freeze([definition]),
  executor: identity,
  lifecycle: 'active',
  policyReferences: Object.freeze([policy]),
  execute: () => Promise.resolve({}),
});

const configSchema = z.object({}).strict();
const objectSchema = z.record(z.string(), z.json());

function release(): ReturnType<typeof createRegistryRelease> {
  return createRegistryRelease({
    definitions: [manifest],
    epoch: 1,
    executors: [
      {
        abiVersion: 1,
        definitions: [definition],
        executor,
        lifecycle: 'active',
        policyReferences: [policy],
      },
    ],
    policies: [policy],
  });
}

describe('node-sdk registry release contracts', () => {
  it('rejects malformed and unbounded executor failure kinds', () => {
    expect(
      () =>
        new NodeExecutorFailure({
          kind: 'failed',
          errorKind: 'x'.repeat(65),
          possiblyDispatched: false,
        }),
    ).toThrow(new TypeError('Invalid node executor failure'));
    expect(
      () =>
        new NodeExecutorFailure({
          kind: 'failed',
          errorKind: 'Provider Secret',
          possiblyDispatched: false,
        }),
    ).toThrow(new TypeError('Invalid node executor failure'));
  });

  it('enforces monotonic definition and executor lifecycle successors', () => {
    expect(DEFINITION_LIFECYCLE_TRANSITIONS).toEqual({
      active: ['deprecated', 'migration_required'],
      deprecated: ['migration_required', 'retired'],
      migration_required: ['retired'],
      retired: [],
    });
    expect(EXECUTOR_LIFECYCLE_TRANSITIONS).toEqual({
      staged: ['active'],
      active: ['retained'],
      retained: ['retirement_blocked'],
      retirement_blocked: ['retained', 'retired'],
      retired: [],
    });

    const one = release();
    const retained = createRegistryReleaseSuccessor({
      previous: one,
      epoch: 2,
      definitions: one.definitions,
      executors: one.executors.map((item) => ({
        ...item,
        lifecycle: 'retained' as const,
      })),
      policies: one.policies,
    });
    expect(retained.executors[0]?.lifecycle).toBe('retained');
    expect(() =>
      createRegistryReleaseSuccessor({
        previous: retained,
        epoch: 3,
        definitions: retained.definitions,
        executors: retained.executors.map((item) => ({
          ...item,
          lifecycle: 'active' as const,
        })),
        policies: retained.policies,
      }),
    ).toThrow('executor lifecycle transition');
    expect(() =>
      createRegistryReleaseSuccessor({
        previous: one,
        epoch: 2,
        definitions: one.definitions.map((item) => ({
          ...item,
          lifecycle: 'retired' as const,
        })),
        executors: one.executors,
        policies: one.policies,
      }),
    ).toThrow('definition lifecycle transition');
  });

  it('requires stable identity behavior and reviewed additive/removal states', () => {
    const one = release();
    expect(() =>
      createRegistryReleaseSuccessor({
        previous: one,
        epoch: 2,
        definitions: [{ ...manifest, retryClass: 'unsafe' }],
        executors: one.executors,
        policies: one.policies,
      }),
    ).toThrow('definition identity behavior');
    expect(() =>
      createRegistryReleaseSuccessor({
        previous: one,
        epoch: 2,
        definitions: one.definitions,
        executors: [
          ...one.executors,
          {
            abiVersion: 1,
            definitions: [],
            executor: { key: 'test.new', version: 1 },
            lifecycle: 'active',
            policyReferences: [],
          },
        ],
        policies: one.policies,
      }),
    ).toThrow('new executor must be staged');
    expect(() =>
      createRegistryReleaseSuccessor({
        previous: one,
        epoch: 2,
        definitions: [],
        executors: [],
        policies: one.policies,
      }),
    ).toThrow('cannot be removed before retired');
  });

  it('produces a declaration-order-independent full fingerprint', () => {
    const one = release();
    const reversed = createRegistryRelease({
      definitions: [...one.definitions].reverse(),
      epoch: one.epoch,
      executors: [...one.executors].reverse(),
      policies: [...one.policies].reverse(),
    });

    expect(reversed.fingerprint).toBe(one.fingerprint);
    expect(computeCompatibilityReleaseFingerprint(one)).toBe(one.fingerprint);
    expect(registryReleaseSchema.parse(one)).toEqual(one);
    expect(one.fingerprint).toBe(
      'node-compat:v1:sha256:0ad188367be35938873560920ff9cb5d8b3ad6e5432ef5043bf3c1e330231eb0',
    );
    expect(one.fingerprint).toBe(
      `node-compat:v1:sha256:${createHash('sha256')
        .update(canonicalCompatibilityReleaseJson(one))
        .digest('hex')}`,
    );
  });

  it('changes the full fingerprint for lifecycle and binding changes', () => {
    const one = release();
    const deprecated = createRegistryRelease({
      definitions: [{ ...manifest, lifecycle: 'deprecated' }],
      epoch: one.epoch + 1,
      executors: one.executors,
      policies: one.policies,
    });
    expect(deprecated.fingerprint).not.toBe(one.fingerprint);
    expect(() =>
      createRegistryRelease({
        definitions: [
          { ...manifest, executor: { key: 'test.other', version: 1 } },
        ],
        epoch: one.epoch + 2,
        executors: one.executors,
        policies: one.policies,
      }),
    ).toThrow(/unknown executor/u);
  });

  it('validates and fingerprints stable integration operation metadata', () => {
    const integrated = createRegistryRelease({
      definitions: [
        {
          ...manifest,
          connectionRequirements: ['primary'],
          integration: { providerKey: 'http', operationKey: 'request' },
        },
      ],
      epoch: 2,
      executors: release().executors,
      policies: release().policies,
    });
    expect(integrated.fingerprint).not.toBe(release().fingerprint);
    expect(registryReleaseSchema.parse(integrated)).toEqual(integrated);
    expect(
      nodeManifestSchema.safeParse({
        ...manifest,
        integration: { providerKey: 'HTTP', operationKey: 'request' },
      }).success,
    ).toBe(false);
  });

  it('rejects recursively deep schema documents before fingerprint traversal', () => {
    let deepSchema: Record<string, unknown> = {};
    for (let depth = 0; depth < 65; depth += 1)
      deepSchema = { nested: deepSchema };
    expect(
      nodeManifestSchema.safeParse({ ...manifest, configSchema: deepSchema })
        .success,
    ).toBe(false);
  });

  it('selects only pinned definitions, executors, and policies', () => {
    const one = release();
    const withUnrelated = createRegistryRelease({
      definitions: [
        ...one.definitions,
        {
          ...manifest,
          definition: { key: 'test.other', version: 1 },
          executor: { key: 'test.other', version: 1 },
        },
      ],
      epoch: one.epoch + 1,
      executors: [
        ...one.executors,
        {
          abiVersion: 1,
          definitions: [{ key: 'test.other', version: 1 }],
          executor: { key: 'test.other', version: 1 },
          lifecycle: 'active',
          policyReferences: [policy],
        },
      ],
      policies: one.policies,
    });

    expect(computeCompatibilitySelectionFingerprint(one, [definition])).toBe(
      computeCompatibilitySelectionFingerprint(withUnrelated, [definition]),
    );
    expect(() =>
      computeCompatibilitySelectionFingerprint(one, [definition, definition]),
    ).toThrow(/duplicate selected definition/u);
  });
});

describe('node-sdk exact server registry', () => {
  it('keeps browser and server bounded JSON admission in parity', () => {
    expect(
      generateSchemaDocument(boundedNodeJsonSchema)[
        'x-pertexo-node-json-limits'
      ],
    ).toEqual(NODE_EXECUTION_LIMITS_V1);
    const exact = 'x'.repeat(NODE_EXECUTION_LIMITS_V1.bytes - 2);
    const over = `${exact}x`;
    expect(boundedNodeJsonSchema.safeParse(exact).success).toBe(true);
    expect(() => canonicalizeBoundedJson(exact)).not.toThrow();
    expect(boundedNodeJsonSchema.safeParse(over).success).toBe(false);
    expect(() => canonicalizeBoundedJson(over)).toThrow(
      InvalidBoundedJsonError,
    );

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(boundedNodeJsonSchema.safeParse(cyclic).success).toBe(false);
    expect(() => canonicalizeBoundedJson(cyclic)).toThrow(
      InvalidBoundedJsonError,
    );

    const sparse = new Array<unknown>(1);
    expect(boundedNodeJsonSchema.safeParse(sparse).success).toBe(false);
    expect(() => canonicalizeBoundedJson(sparse)).toThrow(
      InvalidBoundedJsonError,
    );

    const oversizedSparse = new Array<unknown>(
      NODE_EXECUTION_LIMITS_V1.members + 1,
    );
    expect(boundedNodeJsonSchema.safeParse(oversizedSparse).success).toBe(
      false,
    );
    expect(() => canonicalizeBoundedJson(oversizedSparse)).toThrow(
      InvalidBoundedJsonError,
    );

    const shared = { value: true };
    const repeated = [shared, shared];
    expect(boundedNodeJsonSchema.safeParse(repeated).success).toBe(false);
    expect(() => canonicalizeBoundedJson(repeated)).toThrow(
      InvalidBoundedJsonError,
    );
  });

  it('enforces scalar byte limits before returning normalized JSON', () => {
    const exact = 'x'.repeat(NODE_EXECUTION_LIMITS_V1.bytes - 2);
    expect(canonicalizeBoundedJson(exact)).toBe(exact);
    expect(() => canonicalizeBoundedJson(`${exact}x`)).toThrow(
      InvalidBoundedJsonError,
    );

    const envelope = { config: { value: '' }, input: {} };
    const overhead = new TextEncoder().encode(
      JSON.stringify(envelope),
    ).byteLength;
    const aggregateExact = {
      ...envelope,
      config: { value: 'x'.repeat(NODE_EXECUTION_LIMITS_V1.bytes - overhead) },
    };
    expect(canonicalizeBoundedJson(aggregateExact)).toEqual(aggregateExact);
    expect(() =>
      canonicalizeBoundedJson({
        ...aggregateExact,
        config: { value: `${aggregateExact.config.value}x` },
      }),
    ).toThrow(InvalidBoundedJsonError);
  });

  it('enforces exact member and depth limits without recursive traversal', () => {
    expect(
      canonicalizeBoundedJson(
        { left: 1, right: 2 },
        { bytes: 100, depth: 1, members: 2 },
      ),
    ).toEqual({ left: 1, right: 2 });
    expect(() =>
      canonicalizeBoundedJson(
        { left: 1, right: 2, third: 3 },
        { bytes: 100, depth: 1, members: 2 },
      ),
    ).toThrow(/member limit/u);
    expect(
      canonicalizeBoundedJson(
        { nested: {} },
        { bytes: 100, depth: 2, members: 2 },
      ),
    ).toEqual({ nested: {} });
    expect(() =>
      canonicalizeBoundedJson(
        { nested: { tooDeep: {} } },
        { bytes: 100, depth: 2, members: 3 },
      ),
    ).toThrow(/depth limit/u);
  });

  it('rejects duplicate identities and mismatched bindings', () => {
    const one = release();
    expect(() =>
      createNodeRegistry({
        definitions: [
          {
            manifest,
            configSchema,
            inputSchema: objectSchema,
            outputSchema: objectSchema,
          },
          {
            manifest,
            configSchema,
            inputSchema: objectSchema,
            outputSchema: objectSchema,
          },
        ],
        executors: [executorRegistration()],
        release: one,
      }),
    ).toThrow(NodeRegistryCompatibilityError);
  });

  it('rejects runtime schemas that drift from their published documents', () => {
    expect(() =>
      createNodeRegistry({
        definitions: [
          {
            manifest,
            configSchema: z.string(),
            inputSchema: objectSchema,
            outputSchema: objectSchema,
          },
        ],
        executors: [executorRegistration()],
        release: release(),
      }),
    ).toThrow(/JSON Schema document/u);
  });

  it('keeps registrations private, snapshots metadata, and enforces aggregate input bounds', async () => {
    const registration = executorRegistration();
    const registry = createNodeRegistry({
      definitions: [
        {
          manifest,
          configSchema,
          inputSchema: objectSchema,
          outputSchema: objectSchema,
        },
      ],
      executors: [registration],
      release: release(),
    });
    expect(Object.keys(registry).sort()).toEqual([
      'compatibility',
      'dispatchMode',
      'execute',
      'historicalCatalog',
      'placementCatalog',
      'publicationCatalog',
    ]);
    expect(Object.isFrozen(registry.compatibility)).toBe(true);
    const half = 'x'.repeat(Math.ceil(NODE_EXECUTION_LIMITS_V1.bytes / 2));
    await expect(
      registry.execute({
        config: { value: half },
        definition,
        executor,
        input: { value: half },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(InvalidBoundedJsonError);
  });

  it('makes ABI 2 dispatch-aware and requires exactly one durable marker', async () => {
    const dispatchManifest = {
      ...manifest,
      executorAbi: 2,
    } satisfies NodeManifest;
    const dispatchRelease = createRegistryRelease({
      definitions: [dispatchManifest],
      epoch: 1,
      executors: [
        {
          abiVersion: 2,
          definitions: [definition],
          executor,
          lifecycle: 'active',
          policyReferences: [policy],
        },
      ],
      policies: [policy],
    });
    const marker = vi.fn(() => Promise.resolve());
    const runtime = {
      workspaceId: '11111111-1111-4111-8111-111111111111',
      runId: '22222222-2222-4222-8222-222222222222',
      nodeRunId: '33333333-3333-4333-8333-333333333333',
      attemptId: '44444444-4444-4444-8444-444444444444',
      attemptNumber: 1,
      nodeId: 'node-1',
      invocationKey: 'invocation-1',
      sideEffectClass: 'unsafe' as const,
      beforeDispatch: marker,
    };
    const request = {
      config: {},
      definition,
      executor,
      input: {},
      connectionRefs: {
        http_headers: '55555555-5555-4555-8555-555555555555',
      },
      signal: new AbortController().signal,
      runtime,
    };
    const registryFor = (execute: NodeExecutorRegistration['execute']) =>
      createNodeRegistry({
        definitions: [
          {
            manifest: dispatchManifest,
            configSchema,
            inputSchema: objectSchema,
            outputSchema: objectSchema,
          },
        ],
        executors: [
          {
            ...executorRegistration(),
            abiVersion: 2,
            execute,
          },
        ],
        release: dispatchRelease,
      });

    const successful = registryFor(async (invocation) => {
      expect(invocation.connectionRefs).toEqual(request.connectionRefs);
      await invocation.runtime?.beforeDispatch();
      return { ok: true };
    });
    expect(successful.dispatchMode(request)).toBe('executor_controlled');
    await expect(successful.execute(request)).resolves.toMatchObject({
      output: { ok: true },
    });
    expect(marker).toHaveBeenCalledOnce();

    await expect(
      registryFor(() => Promise.resolve({})).execute(request),
    ).rejects.toBeInstanceOf(NodeDispatchEvidenceError);
    const { runtime: _runtime, ...withoutRuntime } = request;
    void _runtime;
    await expect(successful.execute(withoutRuntime)).rejects.toBeInstanceOf(
      NodeExecutionRuntimeRequiredError,
    );
    await expect(
      registryFor(async (invocation) => {
        await invocation.runtime?.beforeDispatch();
        await invocation.runtime?.beforeDispatch();
        return {};
      }).execute({
        ...request,
        runtime: { ...runtime, beforeDispatch: marker },
      }),
    ).rejects.toMatchObject({ code: 'duplicate_dispatch' });
  });

  it('rejects executor ABIs whose dispatch contract is unknown', () => {
    const unsupportedAbi = 3;
    expect(() =>
      createNodeRegistry({
        definitions: [
          {
            manifest: { ...manifest, executorAbi: unsupportedAbi },
            configSchema,
            inputSchema: objectSchema,
            outputSchema: objectSchema,
          },
        ],
        executors: [
          {
            ...executorRegistration(),
            abiVersion: unsupportedAbi,
          },
        ],
        release: createRegistryRelease({
          definitions: [{ ...manifest, executorAbi: unsupportedAbi }],
          epoch: 1,
          executors: [
            {
              abiVersion: unsupportedAbi,
              definitions: [definition],
              executor,
              lifecycle: 'active',
              policyReferences: [policy],
            },
          ],
          policies: [policy],
        }),
      }),
    ).toThrow(/unsupported ABI 3/u);
  });

  it('derives terminal success from the pinned capability', async () => {
    const terminalManifest = {
      ...manifest,
      capabilities: [TERMINATES_RUN_CAPABILITY],
    } satisfies NodeManifest;
    const terminalRelease = createRegistryRelease({
      definitions: [terminalManifest],
      epoch: 1,
      executors: release().executors,
      policies: [policy],
    });
    const registry = createNodeRegistry({
      definitions: [
        {
          manifest: terminalManifest,
          configSchema,
          inputSchema: objectSchema,
          outputSchema: objectSchema,
        },
      ],
      executors: [executorRegistration()],
      release: terminalRelease,
    });
    await expect(
      registry.execute({
        config: {},
        definition,
        executor,
        input: {},
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'terminal_success' });
  });

  it('rejects cancellation before execution and preserves confirmed success', async () => {
    const before = new AbortController();
    before.abort();
    const normal = createNodeRegistry({
      definitions: [
        {
          manifest,
          configSchema,
          inputSchema: objectSchema,
          outputSchema: objectSchema,
        },
      ],
      executors: [executorRegistration()],
      release: release(),
    });
    await expect(
      normal.execute({
        config: {},
        definition,
        executor,
        input: {},
        signal: before.signal,
      }),
    ).rejects.toBeInstanceOf(NodeExecutionAbortedError);

    const after = new AbortController();
    const aborting = {
      ...executorRegistration(),
      execute: () => {
        after.abort();
        return Promise.resolve({});
      },
    };
    const abortingRegistry = createNodeRegistry({
      definitions: [
        {
          manifest,
          configSchema,
          inputSchema: objectSchema,
          outputSchema: objectSchema,
        },
      ],
      executors: [aborting],
      release: release(),
    });
    await expect(
      abortingRegistry.execute({
        config: {},
        definition,
        executor,
        input: {},
        signal: after.signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: {} });
  });

  it('maps config, input, and output schema failures to stable errors', async () => {
    const schemas = {
      configSchema: z.object({ required: z.string() }).strict(),
      inputSchema: z.object({ required: z.string() }).strict(),
      outputSchema: z.object({ required: z.string() }).strict(),
    };
    const strictManifest = {
      ...manifest,
      configSchema: generateSchemaDocument(schemas.configSchema),
      inputSchema: generateSchemaDocument(schemas.inputSchema),
      outputSchema: generateSchemaDocument(schemas.outputSchema),
    } satisfies NodeManifest;
    const strictRelease = createRegistryRelease({
      definitions: [strictManifest],
      epoch: 1,
      executors: release().executors,
      policies: [policy],
    });
    const strictRegistry = createNodeRegistry({
      definitions: [{ manifest: strictManifest, ...schemas }],
      executors: [executorRegistration()],
      release: strictRelease,
    });
    const request = {
      definition,
      executor,
      signal: new AbortController().signal,
    };
    await expect(
      strictRegistry.execute({
        ...request,
        config: {},
        input: { required: 'x' },
      }),
    ).rejects.toBeInstanceOf(NodeConfigValidationError);
    await expect(
      strictRegistry.execute({
        ...request,
        config: { required: 'x' },
        input: {},
      }),
    ).rejects.toBeInstanceOf(NodeInputValidationError);
    await expect(
      strictRegistry.execute({
        ...request,
        config: { required: 'x' },
        input: { required: 'x' },
      }),
    ).rejects.toBeInstanceOf(NodeOutputValidationError);
  });

  it('separates placement, publication, and historical lifecycle catalogs and executes retained versions', async () => {
    const identities = {
      active: { key: 'test.active', version: 1 },
      deprecated: { key: 'test.deprecated', version: 1 },
      migration: { key: 'test.migration', version: 1 },
      retired: { key: 'test.retired', version: 1 },
    } as const;
    const activeExecutor = { key: 'test.active.executor', version: 1 };
    const retainedExecutor = { key: 'test.retained.executor', version: 1 };
    const manifests = [
      {
        ...manifest,
        definition: identities.active,
        executor: activeExecutor,
        lifecycle: 'active',
      },
      {
        ...manifest,
        definition: identities.deprecated,
        executor: activeExecutor,
        lifecycle: 'deprecated',
      },
      {
        ...manifest,
        definition: identities.migration,
        executor: retainedExecutor,
        lifecycle: 'migration_required',
      },
      {
        ...manifest,
        definition: identities.retired,
        executor: retainedExecutor,
        lifecycle: 'retired',
      },
    ] satisfies NodeManifest[];
    const executorManifests = [
      {
        abiVersion: 1,
        definitions: [identities.active, identities.deprecated],
        executor: activeExecutor,
        lifecycle: 'active',
        policyReferences: [policy],
      },
      {
        abiVersion: 1,
        definitions: [identities.migration, identities.retired],
        executor: retainedExecutor,
        lifecycle: 'retained',
        policyReferences: [policy],
      },
    ] as const;
    const lifecycleRelease = createRegistryRelease({
      definitions: manifests,
      epoch: 1,
      executors: executorManifests,
      policies: [policy],
    });
    const lifecycleRegistry = createNodeRegistry({
      definitions: manifests.map((item) => ({
        manifest: item,
        configSchema,
        inputSchema: objectSchema,
        outputSchema: objectSchema,
      })),
      executors: executorManifests.map((item) => ({
        ...item,
        execute: () => Promise.resolve({ retained: true }),
      })),
      release: lifecycleRelease,
    });
    expect(lifecycleRegistry.placementCatalog().definitions).toEqual([
      identities.active,
    ]);
    expect(lifecycleRegistry.publicationCatalog().definitions).toEqual([
      identities.active,
      identities.deprecated,
    ]);
    expect(lifecycleRegistry.historicalCatalog().definitions).toEqual([
      identities.active,
      identities.deprecated,
      identities.migration,
      identities.retired,
    ]);
    await expect(
      lifecycleRegistry.execute({
        config: {},
        definition: identities.retired,
        executor: retainedExecutor,
        input: {},
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ output: { retained: true } });
  });

  it('resolves the exact executor and never falls forward to another version', async () => {
    const one = release();
    const registry = createNodeRegistry({
      definitions: [
        {
          manifest,
          configSchema,
          inputSchema: objectSchema,
          outputSchema: objectSchema,
        },
      ],
      executors: [executorRegistration()],
      release: one,
    });

    await expect(
      registry.execute({
        config: {},
        definition,
        executor: { key: executor.key, version: 2 },
        input: { value: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ExecutorNotFoundError);
    await expect(
      registry.execute({
        config: {},
        definition: { key: definition.key, version: 2 },
        executor,
        input: { value: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(DefinitionNotFoundError);
  });
});
