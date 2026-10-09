import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  boundedNodeJsonSchema,
  createNodeCatalog,
  generateSchemaDocument,
  isBoundedNodeJson,
  nodeManifestSchema,
  parseNodeCatalog,
  nodeCatalogSchema,
  type DefinitionIdentity,
  type ExecutorIdentity,
  type NodeManifest,
  type PolicyReference,
  TERMINATES_RUN_CAPABILITY,
} from '../src/catalog.js';
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
  type NodeConnectionHealthObservation,
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
const secondPolicy: PolicyReference = Object.freeze({
  key: 'test.policy.second',
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
  outputSchema: generateSchemaDocument(z.record(z.string(), z.json())),
  policyReferences: Object.freeze([policy]),
  ports: Object.freeze({
    inputs: Object.freeze(['in']),
    outputs: Object.freeze(['out']),
  }),
  resourceClass: 'cpu',
  retryClass: 'safe',
  executor,
  executorAbi: 1,
});

const executorRegistration = (
  identity: ExecutorIdentity = executor,
): NodeExecutorRegistration => ({
  executor: identity,
  execute: () => Promise.resolve({}),
});

const configSchema = z.object({}).strict();
const objectSchema = z.record(z.string(), z.json());

function catalog(): ReturnType<typeof createNodeCatalog> {
  return createNodeCatalog({
    definitions: [manifest],
    executors: [
      {
        abiVersion: 1,
        definitions: [definition],
        executor,
        policyReferences: [policy],
      },
    ],
    policies: [policy],
  });
}

function dispatchAwareFixture(beforeDispatch = vi.fn(() => Promise.resolve())) {
  const dispatchManifest = {
    ...manifest,
    executorAbi: 2,
  } satisfies NodeManifest;
  const dispatchCatalog = createNodeCatalog({
    definitions: [dispatchManifest],
    executors: [
      {
        abiVersion: 2,
        definitions: [definition],
        executor,
        policyReferences: [policy],
      },
    ],
    policies: [policy],
  });
  const runtime = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    nodeRunId: '33333333-3333-4333-8333-333333333333',
    attemptId: '44444444-4444-4444-8444-444444444444',
    attemptNumber: 1,
    nodeId: 'node-1',
    invocationKey: 'invocation-1',
    sideEffectClass: 'unsafe' as const,
    beforeDispatch,
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
          execute,
        },
      ],
      catalog: dispatchCatalog,
    });
  return { beforeDispatch, registryFor, request, runtime };
}

describe('node-sdk catalog contracts', () => {
  it('rejects a catalog definition or executor that is not implemented', () => {
    const selected = catalog();
    const registration = {
      manifest,
      configSchema,
      inputSchema: objectSchema,
      outputSchema: objectSchema,
    };
    expect(() =>
      createNodeRegistry({
        catalog: selected,
        definitions: [],
        executors: [executorRegistration()],
      }),
    ).toThrow(
      /catalog definition test.echo@1 has no server schema registration/u,
    );
    expect(() =>
      createNodeRegistry({
        catalog: selected,
        definitions: [registration],
        executors: [],
      }),
    ).toThrow(/catalog executor test.echo@1 has no implementation/u);
  });

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

  it('sorts definitions, executors and policies regardless of declaration order', () => {
    const one = catalog();
    const reversed = createNodeCatalog({
      definitions: [...one.definitions].reverse(),
      executors: [...one.executors].reverse(),
      policies: [...one.policies].reverse(),
    });
    expect(reversed).toEqual(one);
    expect(nodeCatalogSchema.parse(one)).toEqual(one);
  });

  it('rejects duplicate definition policies before set comparison', () => {
    const malformedInput = {
      definitions: [{ ...manifest, policyReferences: [policy, policy] }],
      executors: [
        {
          abiVersion: 1,
          definitions: [definition],
          executor,
          policyReferences: [policy, secondPolicy],
        },
      ],
      policies: [policy, secondPolicy],
    };

    expect(() => createNodeCatalog(malformedInput)).toThrow(
      /duplicate definition policy/u,
    );
    expect(() => parseNodeCatalog(malformedInput)).toThrow(
      /duplicate definition policy/u,
    );
    expect(() =>
      createNodeCatalog({
        ...malformedInput,
        executors: [
          {
            abiVersion: 1,
            definitions: [definition],
            executor,
            policyReferences: [policy, policy],
          },
        ],
      }),
    ).toThrow(/duplicate definition policy/u);
  });

  it('accepts unique reordered policies and rejects unknown or version-drifted edges', () => {
    const reordered = createNodeCatalog({
      definitions: [{ ...manifest, policyReferences: [secondPolicy, policy] }],
      executors: [
        {
          abiVersion: 1,
          definitions: [definition],
          executor,
          policyReferences: [policy, secondPolicy],
        },
      ],
      policies: [secondPolicy, policy],
    });
    const oppositeOrder = createNodeCatalog({
      definitions: [{ ...manifest, policyReferences: [policy, secondPolicy] }],
      executors: [
        {
          abiVersion: 1,
          definitions: [definition],
          executor,
          policyReferences: [secondPolicy, policy],
        },
      ],
      policies: [policy, secondPolicy],
    });

    expect(reordered.definitions).toHaveLength(1);
    expect(oppositeOrder.definitions).toHaveLength(1);
    expect(() =>
      createNodeCatalog({
        definitions: [
          {
            ...manifest,
            policyReferences: [{ ...policy, version: policy.version + 1 }],
          },
        ],
        executors: catalog().executors,
        policies: [policy],
      }),
    ).toThrow(/policies do not match/u);
    expect(() =>
      createNodeCatalog({
        definitions: [{ ...manifest, policyReferences: [secondPolicy] }],
        executors: [
          {
            abiVersion: 1,
            definitions: [definition],
            executor,
            policyReferences: [secondPolicy],
          },
        ],
        policies: [policy],
      }),
    ).toThrow(/unknown policy/u);
  });

  it('rejects a definition bound to an unknown executor', () => {
    const one = catalog();
    expect(() =>
      createNodeCatalog({
        definitions: [
          { ...manifest, executor: { key: 'test.other', version: 1 } },
        ],
        executors: one.executors,
        policies: one.policies,
      }),
    ).toThrow(/unknown executor/u);
  });

  it('validates integration operation metadata', () => {
    const integrated = createNodeCatalog({
      definitions: [
        {
          ...manifest,
          connectionRequirements: ['primary'],
          integration: { providerKey: 'http', operationKey: 'request' },
        },
      ],
      executors: catalog().executors,
      policies: catalog().policies,
    });
    expect(nodeCatalogSchema.parse(integrated)).toEqual(integrated);
    expect(
      nodeManifestSchema.safeParse({
        ...manifest,
        integration: { providerKey: 'HTTP', operationKey: 'request' },
      }).success,
    ).toBe(false);
  });

  it('rejects recursively deep schema documents', () => {
    let deepSchema: Record<string, unknown> = {};
    for (let depth = 0; depth < 65; depth += 1)
      deepSchema = { nested: deepSchema };
    expect(
      nodeManifestSchema.safeParse({ ...manifest, configSchema: deepSchema })
        .success,
    ).toBe(false);
  });

  it('labels runtime-only schema semantics without claiming JSON Schema parity', () => {
    const refined = z.string().refine((value) => value !== 'denied');
    const projection = generateSchemaDocument(refined, {
      runtimeOnlySemantics: ['value must not equal denied'],
    });

    expect(refined.safeParse('denied').success).toBe(false);
    expect(projection).toMatchObject({
      type: 'string',
      'x-pertexo-runtime-only-semantics': ['value must not equal denied'],
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(() =>
      generateSchemaDocument(refined, { runtimeOnlySemantics: [] as never }),
    ).toThrow();
  });
});

describe('node-sdk bounded JSON contracts', () => {
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

    const withExtraArrayProperty: unknown[] & { extra?: string } = [];
    withExtraArrayProperty.extra = 'discarded';
    expect(
      boundedNodeJsonSchema.safeParse(withExtraArrayProperty).success,
    ).toBe(false);
    expect(() => canonicalizeBoundedJson(withExtraArrayProperty)).toThrow(
      InvalidBoundedJsonError,
    );
  });

  it('keeps browser and server admission aligned for hostile root and nested values', () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'must-not-run';
      },
    });
    const symbolBearing = { value: true };
    Object.defineProperty(symbolBearing, Symbol('secret'), {
      enumerable: true,
      value: 'must-not-leak',
    });
    const nestedAccessor = { nested: accessor };
    const nestedSymbolBearing = { nested: symbolBearing };
    const nestedArray: unknown[] & { extra?: string } = [true];
    nestedArray.extra = 'not-json';
    const invalidValues: readonly unknown[] = [
      undefined,
      1n,
      () => undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date('2026-08-20T00:00:00.000Z'),
      symbolBearing,
      accessor,
      nestedAccessor,
      nestedSymbolBearing,
      { nested: undefined },
      { nested: 1n },
      { nested: () => undefined },
      { nested: Number.NEGATIVE_INFINITY },
      { nested: new Map() },
      { nested: nestedArray },
    ];

    for (const value of invalidValues) {
      expect(boundedNodeJsonSchema.safeParse(value).success).toBe(false);
      expect(() => canonicalizeBoundedJson(value)).toThrow(
        InvalidBoundedJsonError,
      );
    }
    expect(getterCalls).toBe(0);
  });

  it('measures and returns one own-data snapshot without invoking hidden JSON hooks', () => {
    let getterCalls = 0;
    let methodCalls = 0;
    const oversized = Object.defineProperty(
      { value: 'x'.repeat(NODE_EXECUTION_LIMITS_V1.bytes) },
      'toJSON',
      {
        get: () => {
          getterCalls += 1;
          return () => {
            methodCalls += 1;
            return {};
          };
        },
      },
    );
    const nested = Object.defineProperty({ value: true }, 'toJSON', {
      value: () => {
        methodCalls += 1;
        return {};
      },
    });
    const oversizedMethod = Object.defineProperty(
      { value: 'x'.repeat(NODE_EXECUTION_LIMITS_V1.bytes) },
      'toJSON',
      {
        value: () => {
          methodCalls += 1;
          return {};
        },
      },
    );
    const nestedGetter = Object.defineProperty({ value: true }, 'toJSON', {
      get: () => {
        getterCalls += 1;
        return () => ({});
      },
    });
    const rootMethod = Object.defineProperty({ value: true }, 'toJSON', {
      value: () => {
        methodCalls += 1;
        return {};
      },
    });

    expect(isBoundedNodeJson(oversized)).toBe(false);
    expect(isBoundedNodeJson(oversizedMethod)).toBe(false);
    expect(boundedNodeJsonSchema.safeParse(oversized).success).toBe(false);
    expect(boundedNodeJsonSchema.safeParse(oversizedMethod).success).toBe(
      false,
    );
    expect(() => canonicalizeBoundedJson(oversized)).toThrow(/byte limit/u);
    expect(() => canonicalizeBoundedJson(oversizedMethod)).toThrow(
      /byte limit/u,
    );
    for (const input of [rootMethod, { nested }, { nested: nestedGetter }]) {
      const browserSnapshot = boundedNodeJsonSchema.parse(input);
      const serverSnapshot = canonicalizeBoundedJson(input);
      expect(browserSnapshot).toEqual(serverSnapshot);
      expect(JSON.stringify(browserSnapshot)).toBe(
        JSON.stringify(serverSnapshot),
      );
      expect(Object.isFrozen(browserSnapshot)).toBe(true);
      for (const child of Object.values(
        browserSnapshot as Record<string, unknown>,
      ))
        if (child !== null && typeof child === 'object')
          expect(Object.isFrozen(child)).toBe(true);
    }
    expect(getterCalls).toBe(0);
    expect(methodCalls).toBe(0);
  });

  it('never reads proxy values after descriptor inspection', () => {
    let getCalls = 0;
    const input = new Proxy(
      { nested: { value: true } },
      {
        get: () => {
          getCalls += 1;
          throw new Error('value trap must not run');
        },
      },
    );
    const arrayInput = new Proxy([{ value: true }], {
      get: () => {
        getCalls += 1;
        throw new Error('array value trap must not run');
      },
    });
    const mutationTarget = { value: 'accepted' };
    let descriptorCalls = 0;
    const mutationInput = new Proxy(mutationTarget, {
      getOwnPropertyDescriptor: (target, key) => {
        descriptorCalls += 1;
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (descriptorCalls === 2) target.value = 'mutated-after-snapshot';
        return descriptor;
      },
    });

    expect(boundedNodeJsonSchema.parse(input)).toEqual({
      nested: { value: true },
    });
    expect(canonicalizeBoundedJson(input)).toEqual({
      nested: { value: true },
    });
    expect(boundedNodeJsonSchema.parse(arrayInput)).toEqual([{ value: true }]);
    expect(canonicalizeBoundedJson(arrayInput)).toEqual([{ value: true }]);
    expect(canonicalizeBoundedJson(mutationInput)).toEqual({
      value: 'accepted',
    });
    expect(mutationTarget.value).toBe('mutated-after-snapshot');
    expect(getCalls).toBe(0);
  });

  it('accepts null-prototype JSON and normalizes negative zero on the server', () => {
    const nullPrototype = Object.assign(Object.create(null) as object, {
      nested: { value: true },
    });
    expect(boundedNodeJsonSchema.safeParse(nullPrototype).success).toBe(true);
    expect(canonicalizeBoundedJson(nullPrototype)).toEqual({
      nested: { value: true },
    });
    expect(boundedNodeJsonSchema.safeParse(-0).success).toBe(true);
    const normalized = canonicalizeBoundedJson(-0);
    expect(normalized).toBe(0);
    expect(Object.is(normalized, -0)).toBe(false);
  });

  it('preserves hostile JSON property names as own data', () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"nested":{"constructor":1,"prototype":2}}',
    ) as unknown;
    const canonical = canonicalizeBoundedJson(input);

    expect(JSON.stringify(canonical)).toBe(JSON.stringify(input));
    expect(Object.hasOwn(canonical as object, '__proto__')).toBe(true);
    expect((canonical as { polluted?: boolean }).polluted).toBeUndefined();

    const hostileManifest = {
      ...manifest,
      configSchema: input as NodeManifest['configSchema'],
    };
    const created = createNodeCatalog({
      definitions: [hostileManifest],
      executors: catalog().executors,
      policies: [policy],
    });
    expect(nodeCatalogSchema.parse(created)).toEqual(created);
    expect(JSON.stringify(created.definitions[0]?.configSchema)).toBe(
      JSON.stringify(input),
    );
  });

  it('normalizes hostile reflection failures and rejects invalid custom limits', () => {
    const secondaryTrap = new Proxy(new Error('hidden'), {
      getPrototypeOf: () => {
        throw new Error('secondary trap escaped');
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const hostileValues = [
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error('prototype trap must not escape');
          },
        },
      ),
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('ownKeys trap must not escape');
          },
        },
      ),
      new Proxy(
        { value: true },
        {
          getOwnPropertyDescriptor: () => {
            throw new Error('descriptor trap must not escape');
          },
        },
      ),
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw secondaryTrap;
          },
        },
      ),
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- hostile inputs may throw arbitrary JavaScript values.
            throw 17;
          },
        },
      ),
      revoked.proxy,
    ];
    const rootAndNestedHostileValues = [
      ...hostileValues,
      ...hostileValues.map((hostile) => ({ nested: hostile })),
    ];
    for (const hostile of rootAndNestedHostileValues) {
      expect(boundedNodeJsonSchema.safeParse(hostile).success).toBe(false);
      expect(() => canonicalizeBoundedJson(hostile)).toThrow(
        InvalidBoundedJsonError,
      );
    }

    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const field of ['bytes', 'depth', 'members'] as const) {
        const limits = { bytes: 1, depth: 1, members: 1, [field]: invalid };
        expect(() => canonicalizeBoundedJson({}, limits)).toThrow(
          InvalidBoundedJsonError,
        );
      }
    }
  });

  it('normalizes hostile catalog parser failures at the public registry boundary', () => {
    const secondaryTrap = new Proxy(new Error('hidden'), {
      getPrototypeOf: () => {
        throw new Error('secondary trap escaped');
      },
    });
    const hostileCatalog = new Proxy(catalog(), {
      ownKeys: () => {
        throw secondaryTrap;
      },
    });

    let failure: unknown;
    try {
      createNodeRegistry({
        definitions: [
          {
            manifest,
            configSchema,
            inputSchema: objectSchema,
            outputSchema: objectSchema,
          },
        ],
        executors: [executorRegistration()],
        catalog: hostileCatalog,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'registry_compatibility' });
  });

  it('enforces scalar byte limits before returning normalized JSON', () => {
    const exact = 'x'.repeat(NODE_EXECUTION_LIMITS_V1.bytes - 2);
    expect(canonicalizeBoundedJson(exact)).toBe(exact);
    expect(() => canonicalizeBoundedJson(`${exact}x`)).toThrow(
      InvalidBoundedJsonError,
    );
    const unicodePayloadBytes = NODE_EXECUTION_LIMITS_V1.bytes - 2;
    const unicodeExact = `${'🚀'.repeat(Math.floor(unicodePayloadBytes / 4))}${'x'.repeat(unicodePayloadBytes % 4)}`;
    expect(new TextEncoder().encode(JSON.stringify(unicodeExact))).toHaveLength(
      NODE_EXECUTION_LIMITS_V1.bytes,
    );
    expect(boundedNodeJsonSchema.parse(unicodeExact)).toBe(unicodeExact);
    expect(canonicalizeBoundedJson(unicodeExact)).toBe(unicodeExact);
    expect(boundedNodeJsonSchema.safeParse(`${unicodeExact}x`).success).toBe(
      false,
    );
    expect(() => canonicalizeBoundedJson(`${unicodeExact}x`)).toThrow(
      /byte limit/u,
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
});

describe('node-sdk exact server registry', () => {
  it('rejects duplicate identities and mismatched bindings', () => {
    const one = catalog();
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
        catalog: one,
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
        catalog: catalog(),
      }),
    ).toThrow(/JSON Schema projection/u);
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
      catalog: catalog(),
    });
    expect(Object.keys(registry).sort()).toEqual(['dispatchMode', 'execute']);
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

  it('executes ABI 2 after one durable marker and requires its runtime', async () => {
    const { beforeDispatch, registryFor, request } = dispatchAwareFixture();
    const registry = registryFor(async (invocation) => {
      expect(invocation.connectionRefs).toEqual(request.connectionRefs);
      await invocation.runtime?.beforeDispatch();
      return { ok: true };
    });
    expect(registry.dispatchMode(request)).toBe('executor_controlled');
    await expect(registry.execute(request)).resolves.toMatchObject({
      output: { ok: true },
    });
    expect(beforeDispatch).toHaveBeenCalledOnce();

    const { runtime: _runtime, ...withoutRuntime } = request;
    await expect(registry.execute(withoutRuntime)).rejects.toBeInstanceOf(
      NodeExecutionRuntimeRequiredError,
    );
  });

  it.each([
    { kind: 'healthy' },
    {
      kind: 'reauthorization_required',
      reasonCode: 'connection.slack_token_revoked',
    },
  ] satisfies readonly NodeConnectionHealthObservation[])(
    'forwards optional synchronous health capture without changing ABI 2 results %#',
    async (observation) => {
      const { registryFor, request, runtime } = dispatchAwareFixture();
      const observeConnectionHealth =
        vi.fn<(value: NodeConnectionHealthObservation) => void>();
      const registry = registryFor(async (invocation) => {
        await invocation.runtime?.beforeDispatch();
        invocation.runtime?.observeConnectionHealth?.(observation);
        return { ok: true };
      });
      await expect(
        registry.execute({
          ...request,
          runtime: { ...runtime, observeConnectionHealth },
        }),
      ).resolves.toEqual({ kind: 'succeeded', output: { ok: true } });
      expect(observeConnectionHealth).toHaveBeenCalledExactlyOnceWith(
        observation,
      );
      await expect(registry.execute(request)).resolves.toEqual({
        kind: 'succeeded',
        output: { ok: true },
      });
      expect(observeConnectionHealth).toHaveBeenCalledOnce();
    },
  );

  it('rejects ABI 2 completion without a durable marker', async () => {
    const { registryFor, request } = dispatchAwareFixture();

    await expect(
      registryFor(() => Promise.resolve({})).execute(request),
    ).rejects.toBeInstanceOf(NodeDispatchEvidenceError);
  });

  it('rejects a second ABI 2 durable marker', async () => {
    const { beforeDispatch, registryFor, request, runtime } =
      dispatchAwareFixture();

    await expect(
      registryFor(async (invocation) => {
        await invocation.runtime?.beforeDispatch();
        await invocation.runtime?.beforeDispatch();
        return {};
      }).execute({
        ...request,
        runtime: { ...runtime, beforeDispatch },
      }),
    ).rejects.toMatchObject({ code: 'duplicate_dispatch' });
    expect(beforeDispatch).toHaveBeenCalledOnce();
  });

  it('admits only one concurrent ABI 2 durable marker', async () => {
    let releaseMarker: (() => void) | undefined;
    const deferredMarker = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseMarker = resolve;
        }),
    );
    const { registryFor, request, runtime } =
      dispatchAwareFixture(deferredMarker);
    const concurrent = registryFor(async (invocation) => {
      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          Promise.resolve(invocation.runtime?.beforeDispatch()),
        ),
      );
      expect(
        attempts.filter(({ status }) => status === 'rejected'),
      ).toHaveLength(7);
      return {};
    }).execute({
      ...request,
      runtime: { ...runtime, beforeDispatch: deferredMarker },
    });
    await vi.waitFor(() => {
      expect(deferredMarker).toHaveBeenCalledOnce();
    });
    releaseMarker?.();
    await expect(concurrent).resolves.toMatchObject({ output: {} });
  });

  it('does not retry a rejected ABI 2 durable marker', async () => {
    const rejectedMarker = vi.fn(() =>
      Promise.reject(new Error('durable marker rejected')),
    );
    const { registryFor, request, runtime } =
      dispatchAwareFixture(rejectedMarker);
    await expect(
      registryFor(async (invocation) => {
        await expect(invocation.runtime?.beforeDispatch()).rejects.toThrow(
          'durable marker rejected',
        );
        await expect(
          invocation.runtime?.beforeDispatch(),
        ).rejects.toMatchObject({ code: 'duplicate_dispatch' });
        return {};
      }).execute({
        ...request,
        runtime: { ...runtime, beforeDispatch: rejectedMarker },
      }),
    ).rejects.toMatchObject({ code: 'dispatch_evidence_missing' });
    expect(rejectedMarker).toHaveBeenCalledOnce();
  });

  it('preserves executor rejection while an ABI 2 marker remains in flight', async () => {
    let resolveInFlight: (() => void) | undefined;
    const inFlightMarker = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveInFlight = resolve;
        }),
    );
    const { registryFor, request, runtime } =
      dispatchAwareFixture(inFlightMarker);
    const executorFailure = registryFor((invocation) => {
      void invocation.runtime?.beforeDispatch();
      return Promise.reject(new Error('executor rejected while marking'));
    }).execute({
      ...request,
      runtime: { ...runtime, beforeDispatch: inFlightMarker },
    });
    await vi.waitFor(() => {
      expect(inFlightMarker).toHaveBeenCalledOnce();
    });
    await expect(executorFailure).rejects.toThrow(
      'executor rejected while marking',
    );
    resolveInFlight?.();
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
        executors: [executorRegistration()],
        catalog: createNodeCatalog({
          definitions: [{ ...manifest, executorAbi: unsupportedAbi }],
          executors: [
            {
              abiVersion: unsupportedAbi,
              definitions: [definition],
              executor,
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
    const terminalCatalog = createNodeCatalog({
      definitions: [terminalManifest],
      executors: catalog().executors,
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
      catalog: terminalCatalog,
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
      catalog: catalog(),
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
      catalog: catalog(),
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
    const strictCatalog = createNodeCatalog({
      definitions: [strictManifest],
      executors: catalog().executors,
      policies: [policy],
    });
    const strictRegistry = createNodeRegistry({
      definitions: [{ manifest: strictManifest, ...schemas }],
      executors: [executorRegistration()],
      catalog: strictCatalog,
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

  it('resolves the exact executor and never falls forward to another version', async () => {
    const one = catalog();
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
      catalog: one,
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

  it('preserves definition and executor resolution order across registry entrypoints', async () => {
    const otherDefinition = { key: 'test.other', version: 1 } as const;
    const otherExecutor = { key: 'test.other', version: 1 } as const;
    const otherManifest = {
      ...manifest,
      definition: otherDefinition,
      executor: otherExecutor,
    } satisfies NodeManifest;
    const [baseExecutor] = catalog().executors;
    if (baseExecutor === undefined)
      throw new Error('test release is missing its executor');
    const exactCatalog = createNodeCatalog({
      definitions: [manifest, otherManifest],
      executors: [
        baseExecutor,
        {
          abiVersion: 1,
          definitions: [otherDefinition],
          executor: otherExecutor,
          policyReferences: [policy],
        },
      ],
      policies: [policy],
    });
    const registry = createNodeRegistry({
      definitions: [manifest, otherManifest].map((item) => ({
        manifest: item,
        configSchema,
        inputSchema: objectSchema,
        outputSchema: objectSchema,
      })),
      executors: [executorRegistration(), executorRegistration(otherExecutor)],
      catalog: exactCatalog,
    });
    const missingDefinition = { key: definition.key, version: 2 } as const;
    const missingExecutor = { key: executor.key, version: 2 } as const;

    expect(() =>
      registry.dispatchMode({
        definition: missingDefinition,
        executor: missingExecutor,
      }),
    ).toThrow(ExecutorNotFoundError);
    await expect(
      registry.execute({
        config: {},
        definition: missingDefinition,
        executor: missingExecutor,
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ExecutorNotFoundError);

    expect(() =>
      registry.dispatchMode({ definition: missingDefinition, executor }),
    ).toThrow(DefinitionNotFoundError);
    await expect(
      registry.execute({
        config: {},
        definition: missingDefinition,
        executor,
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(DefinitionNotFoundError);

    const bindingError =
      'definition test.echo@1 is not bound to executor test.other@1';
    expect(() =>
      registry.dispatchMode({ definition, executor: otherExecutor }),
    ).toThrow(bindingError);
    await expect(
      registry.execute({
        config: {},
        definition,
        executor: otherExecutor,
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(bindingError);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      registry.execute({
        config: {},
        definition: missingDefinition,
        executor: missingExecutor,
        input: {},
        signal: aborted.signal,
      }),
    ).rejects.toBeInstanceOf(NodeExecutionAbortedError);
    expect(registry.dispatchMode({ definition, executor })).toBe(
      'before_execute',
    );
    await expect(
      registry.execute({
        config: {},
        definition,
        executor,
        input: {},
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: {} });
  });
});
