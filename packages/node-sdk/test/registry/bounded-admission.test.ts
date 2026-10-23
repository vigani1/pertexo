import { describe, expect, it } from 'vitest';

import { boundedNodeJsonSchema } from '../../src/definitions/catalog.js';
import {
  InvalidBoundedJsonError,
  NODE_EXECUTION_LIMITS,
  canonicalizeBoundedJson,
  createNodeRegistry,
} from '../../src/server.js';
import {
  manifest,
  executorRegistration,
  configSchema,
  objectSchema,
  catalog,
} from '../support/registry.js';

describe('node-sdk bounded JSON contracts', () => {
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
    const exact = 'x'.repeat(NODE_EXECUTION_LIMITS.bytes - 2);
    expect(canonicalizeBoundedJson(exact)).toBe(exact);
    expect(() => canonicalizeBoundedJson(`${exact}x`)).toThrow(
      InvalidBoundedJsonError,
    );
    const unicodePayloadBytes = NODE_EXECUTION_LIMITS.bytes - 2;
    const unicodeExact = `${'🚀'.repeat(Math.floor(unicodePayloadBytes / 4))}${'x'.repeat(unicodePayloadBytes % 4)}`;
    expect(new TextEncoder().encode(JSON.stringify(unicodeExact))).toHaveLength(
      NODE_EXECUTION_LIMITS.bytes,
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
      config: { value: 'x'.repeat(NODE_EXECUTION_LIMITS.bytes - overhead) },
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
