import { describe, expect, it } from 'vitest';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';

import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  computeWorkflowExecutableChecksum,
  parseWorkflowExecutable,
  verifyWorkflowExecutable,
  WORKFLOW_EXECUTABLE_LIMITS,
} from '../src/index.js';
import {
  nodeCatalog,
  conditionGraph,
  switchGraph,
  parallelGraph,
  directPairedParallelGraph,
  graph,
  forEachGraph,
} from './executable-workflow.fixtures.js';

describe('workflow executable V2 identity', () => {
  it('rejects a Condition edge through an undeclared output port', () => {
    const catalog = composeExecutableCatalog(nodeCatalog({ condition: true }));

    expect(() =>
      buildWorkflowExecutable({
        graph: conditionGraph('out'),
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('rejects Condition branches that reconverge before Merge exists', () => {
    const catalog = composeExecutableCatalog(nodeCatalog({ condition: true }));
    const reconverging = conditionGraph('true');

    expect(() =>
      buildWorkflowExecutable({
        graph: {
          ...reconverging,
          edges: [
            ...reconverging.edges,
            {
              id: 'condition-false-terminate',
              source: { nodeId: 'condition', port: 'false' },
              target: { nodeId: 'terminate', port: 'in' },
            },
          ],
        },
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('rejects Switch edges through unconfigured cases and pre-Merge reconvergence', () => {
    const catalog = composeExecutableCatalog(nodeCatalog({ switch: true }));
    expect(() =>
      buildWorkflowExecutable({
        graph: switchGraph('case-03'),
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));

    const reconverging = switchGraph('case-02');
    expect(() =>
      buildWorkflowExecutable({
        graph: {
          ...reconverging,
          edges: [
            ...reconverging.edges,
            {
              id: 'switch-default-terminate',
              source: { nodeId: 'switch', port: 'default' },
              target: { nodeId: 'terminate', port: 'in' },
            },
          ],
        },
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('requires every declared Parallel branch exactly once without pre-Merge reconvergence', () => {
    const catalog = composeExecutableCatalog(nodeCatalog({ parallel: true }));
    expect(() =>
      buildWorkflowExecutable({
        graph: parallelGraph('branch-03'),
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    const missing = parallelGraph();
    expect(() =>
      buildWorkflowExecutable({
        graph: { ...missing, edges: missing.edges.slice(0, 2) },
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    const reconverging = parallelGraph();
    expect(() =>
      buildWorkflowExecutable({
        graph: {
          ...reconverging,
          edges: [
            ...reconverging.edges,
            {
              id: 'left-right',
              source: { nodeId: 'left', port: 'out' },
              target: { nodeId: 'right', port: 'in' },
            },
          ],
        },
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it.each([1, 2, 3] as const)(
    'accepts direct Parallel V%s branches into paired Merge inputs',
    (structuredVersion) => {
      const catalog = composeExecutableCatalog(
        nodeCatalog({ parallel: true, merge: true, structuredVersion }),
      );
      expect(() =>
        buildWorkflowExecutable({
          graph: directPairedParallelGraph(structuredVersion),
          catalog,
        }),
      ).not.toThrow();
    },
  );

  it('composes engine-owned policies and produces the pre-publication golden checksum', () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const compiled = buildWorkflowExecutable({ graph: graph(), catalog });
    expect(compiled.envelope.graph.nodes.map(({ id }) => id)).toEqual([
      'manual',
      'set',
      'terminate',
    ]);
    expect(
      compiled.envelope.graph.nodes.map(
        ({ sideEffectClass }) => sideEffectClass,
      ),
    ).toEqual(['safe', 'safe', 'safe']);
    expect(compiled.checksum).toBe(
      'wf:v2:sha256:844f922fbfa8d364b0870207bedb1bc14313c5c7e3d1f12178c9399ffc88ca92',
    );
    expect(
      verifyWorkflowExecutable({
        ...compiled,
        catalog,
      }),
    ).toEqual(compiled);
  });

  it('is invariant to graph order and unrelated catalog additions', () => {
    const firstCatalog = composeExecutableCatalog(nodeCatalog());
    const laterCatalog = composeExecutableCatalog(
      nodeCatalog({ unrelated: true }),
    );
    const first = buildWorkflowExecutable({
      graph: graph(),
      catalog: firstCatalog,
    });
    const later = buildWorkflowExecutable({
      graph: graph(true),
      catalog: laterCatalog,
    });
    expect(later.checksum).toBe(first.checksum);
    const explicitFalse = structuredClone(graph());
    explicitFalse.nodes.forEach((node) =>
      Object.assign(node, { disabled: false }),
    );
    const explicit = buildWorkflowExecutable({
      graph: explicitFalse,
      catalog: firstCatalog,
    });
    expect(explicit.checksum).toBe(first.checksum);
    expect(first.envelope.graph.nodes.every(({ disabled }) => !disabled)).toBe(
      true,
    );
  });

  it('changes identity for a selected compatibility mutation', () => {
    const original = composeExecutableCatalog(nodeCatalog());
    const changed = composeExecutableCatalog(nodeCatalog({ mutateSet: true }));
    expect(
      buildWorkflowExecutable({ graph: graph(), catalog: changed }).checksum,
    ).not.toBe(
      buildWorkflowExecutable({ graph: graph(), catalog: original }).checksum,
    );
  });

  it('pins side-effect class into behavior identity and rejects a mutated pin', () => {
    const safeCatalog = composeExecutableCatalog(nodeCatalog());
    const idempotentCatalog = composeExecutableCatalog(
      nodeCatalog({ setRetryClass: 'idempotent-with-key' }),
    );
    const safe = buildWorkflowExecutable({
      graph: graph(),
      catalog: safeCatalog,
    });
    const idempotent = buildWorkflowExecutable({
      graph: graph(),
      catalog: idempotentCatalog,
    });
    expect(
      idempotent.envelope.graph.nodes.find(({ id }) => id === 'set')
        ?.sideEffectClass,
    ).toBe('idempotent_with_key');
    expect(idempotent.checksum).not.toBe(safe.checksum);

    const mutated = structuredClone(safe.envelope);
    const set = mutated.graph.nodes.find(({ id }) => id === 'set');
    if (set === undefined) throw new Error('fixture set node missing');
    Object.assign(set, { sideEffectClass: 'unsafe' });
    expect(computeWorkflowExecutableChecksum(mutated)).not.toBe(safe.checksum);
    expect(() =>
      parseWorkflowExecutable({
        envelope: mutated,
        catalog: safeCatalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));

    for (const invalidClass of ['idempotent-with-key', 'unknown']) {
      const wrong = structuredClone(safe.envelope);
      const wrongSet = wrong.graph.nodes.find(({ id }) => id === 'set');
      if (wrongSet === undefined) throw new Error('fixture set node missing');
      Object.assign(wrongSet, { sideEffectClass: invalidClass });
      expect(() =>
        parseWorkflowExecutable({
          envelope: wrong,
          catalog: safeCatalog,
        }),
      ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    }

    const missing = structuredClone(safe.envelope);
    const missingSet = missing.graph.nodes.find(({ id }) => id === 'set');
    if (missingSet === undefined) throw new Error('fixture set node missing');
    Reflect.deleteProperty(missingSet, 'sideEffectClass');
    expect(() =>
      parseWorkflowExecutable({
        envelope: missing,
        catalog: safeCatalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));

    const driftedCurrent = composeExecutableCatalog(
      nodeCatalog({ setRetryClass: 'idempotent-with-key' }),
    );
    expect(() =>
      parseWorkflowExecutable({
        envelope: safe.envelope,
        catalog: driftedCurrent,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('maps all manifest retry classes once into pinned ADR 007 vocabulary', () => {
    const catalog = composeExecutableCatalog(
      nodeCatalog({
        manualRetryClass: 'unsafe',
        setRetryClass: 'idempotent-with-key',
      }),
    );
    expect(
      buildWorkflowExecutable({
        graph: graph(),
        catalog,
      }).envelope.graph.nodes.map(({ sideEffectClass }) => sideEffectClass),
    ).toEqual(['unsafe', 'idempotent_with_key', 'safe']);
  });

  it('fails closed for mutated pins, checksum, malformed envelopes, and V1 input', () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const compiled = buildWorkflowExecutable({ graph: graph(), catalog });
    const mutated = structuredClone(compiled.envelope);
    const set = mutated.graph.nodes.find(({ id }) => id === 'set');
    if (set === undefined) throw new Error('fixture set node missing');
    Object.assign(set.executor, { version: 2 });
    expect(() =>
      parseWorkflowExecutable({
        envelope: mutated,
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    expect(() =>
      verifyWorkflowExecutable({
        envelope: compiled.envelope,
        checksum: compiled.checksum.replace(/.$/u, '0'),
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    expect(() =>
      parseWorkflowExecutable({
        envelope: { ...compiled.envelope, unknown: true },
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    expect(() =>
      parseWorkflowExecutable({
        envelope: { schemaVersion: 1 },
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    let trapCalls = 0;
    const hostile = new Proxy(compiled.envelope, {
      ownKeys: () => {
        trapCalls += 1;
        throw new Error('trap ran');
      },
    });
    expect(() =>
      parseWorkflowExecutable({
        envelope: hostile,
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    expect(trapCalls).toBe(0);
  });

  it('preserves escaped, control, and Unicode JSON while normalizing negative zero', () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const source = structuredClone(graph());
    const set = source.nodes.find(({ id }) => id === 'set');
    if (set === undefined) throw new Error('fixture set node missing');
    Object.assign(set.inputMappings, {
      literal: {
        kind: 'literal',
        value: {
          escaped: 'line\n"quoted"\\slash',
          control: '\u0001',
          euro: '€',
          loneHighSurrogate: '\ud800',
          loneLowSurrogate: '\udc00',
          unicode: 'Živjo 🙂',
          negativeZero: -0,
        },
      },
    });

    const compiled = buildWorkflowExecutable({ graph: source, catalog });
    const parsed = parseWorkflowExecutable({
      envelope: compiled.envelope,
      catalog: catalog,
    });
    const parsedSet = parsed.graph.nodes.find(({ id }) => id === 'set');
    const literal = parsedSet?.inputMappings.literal;
    expect(literal).toMatchObject({
      kind: 'literal',
      value: {
        escaped: 'line\n"quoted"\\slash',
        control: '\u0001',
        euro: '€',
        loneHighSurrogate: '\ud800',
        loneLowSurrogate: '\udc00',
        unicode: 'Živjo 🙂',
        negativeZero: 0,
      },
    });
    if (literal?.kind !== 'literal' || typeof literal.value !== 'object')
      throw new Error('fixture literal mapping missing');
    expect(
      Object.is((literal.value as { negativeZero: number }).negativeZero, -0),
    ).toBe(false);
  });

  it('rejects hostile raw executable JSON without invoking accessors', () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const compiled = buildWorkflowExecutable({ graph: graph(), catalog });
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'must-not-run';
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const hidden = Object.defineProperty({}, 'hidden', {
      enumerable: false,
      value: true,
    });
    const withSymbol = { value: true };
    Object.defineProperty(withSymbol, Symbol('secret'), {
      enumerable: true,
      value: 'must-not-leak',
    });
    const sparse = new Array<unknown>(1);
    const inheritedArray: unknown[] = [];
    Object.setPrototypeOf(inheritedArray, { inherited: true });
    const extraArray = Object.assign([], { extra: true });
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 65; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const oversizedArray = new Array<unknown>(
      WORKFLOW_EXECUTABLE_LIMITS.members + 1,
    ).fill(null);
    const tooManyMembers = Array.from({ length: 1_001 }, () =>
      new Array<number>(WORKFLOW_EXECUTABLE_LIMITS.members / 1_000).fill(0),
    );
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          getterCalls += 1;
          return [];
        },
      },
    );

    for (const [name, hostile] of [
      ['accessor member', accessor],
      ['cyclic object', cycle],
      ['Date instance', new Date('2026-08-20T00:00:00.000Z')],
      ['hidden member', hidden],
      ['symbol member', withSymbol],
      ['sparse array', sparse],
      ['inherited array', inheritedArray],
      ['array with extra member', extraArray],
      ['over-depth object', deep],
      ['oversized array', oversizedArray],
      ['object with too many members', tooManyMembers],
      ['proxy object', proxy],
      ['undefined', undefined],
      ['bigint', 1n],
      ['function', () => undefined],
      ['NaN', Number.NaN],
      ['positive infinity', Number.POSITIVE_INFINITY],
    ] as const) {
      const envelope = structuredClone(compiled.envelope);
      const set = envelope.graph.nodes.find(({ id }) => id === 'set');
      if (set === undefined) throw new Error('fixture set node missing');
      Object.assign(set.inputMappings, {
        literal: { kind: 'literal', value: hostile },
      });
      expect(
        () => parseWorkflowExecutable({ envelope, catalog: catalog }),
        name,
      ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    }
    expect(getterCalls).toBe(0);
  });

  it('rejects malformed raw envelope and policy records at the public parser', () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const compiled = buildWorkflowExecutable({ graph: graph(), catalog });

    expect(() =>
      parseWorkflowExecutable({ envelope: null, catalog: catalog }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));

    for (const mutate of [
      (envelope: Record<string, unknown>) => {
        const policies = envelope.runtimePolicies as Record<string, unknown>;
        policies.scheduler = { key: 'Invalid.Key', version: 1 };
      },
      (envelope: Record<string, unknown>) => {
        const policies = envelope.runtimePolicies as Record<string, unknown>;
        policies.scheduler = { key: 'engine.scheduler', version: 0 };
      },
      (envelope: Record<string, unknown>) => {
        const graphRecord = envelope.graph as Record<string, unknown>;
        const nodes = graphRecord.nodes as Record<string, unknown>[];
        if (nodes[0] === undefined) throw new Error('fixture node missing');
        nodes[0].policyReferences = 'not-an-array';
      },
      (envelope: Record<string, unknown>) => {
        const graphRecord = envelope.graph as Record<string, unknown>;
        const nodes = graphRecord.nodes as Record<string, unknown>[];
        if (nodes[0] === undefined) throw new Error('fixture node missing');
        const policy = { key: 'engine.bounded_json', version: 1 };
        nodes[0].policyReferences = [policy, policy];
      },
    ]) {
      const envelope = structuredClone(compiled.envelope) as unknown as Record<
        string,
        unknown
      >;
      mutate(envelope);
      expect(() =>
        parseWorkflowExecutable({ envelope, catalog: catalog }),
      ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    }
  });

  it('recursively pins, orders, checksums, parses, and verifies For Each bodies', () => {
    const catalog = composeExecutableCatalog(nodeCatalog({ forEach: true }));
    const compiled = buildWorkflowExecutable({
      graph: forEachGraph(true),
      catalog,
    });
    const loop = compiled.envelope.graph.nodes.find(({ id }) => id === 'loop');

    expect(loop?.structured?.body.nodes.map(({ id }) => id)).toEqual([
      'body-first',
      'body-sink',
    ]);
    expect(
      loop?.structured?.body.nodes.every(
        ({ executor }) => executor.version === 1,
      ),
    ).toBe(true);
    expect(compiled.checksum).toBe(
      buildWorkflowExecutable({ graph: forEachGraph(), catalog }).checksum,
    );
    expect(verifyWorkflowExecutable({ ...compiled, catalog: catalog })).toEqual(
      compiled,
    );

    const mutated = structuredClone(compiled.envelope);
    const mutatedLoop = mutated.graph.nodes.find(({ id }) => id === 'loop');
    if (mutatedLoop?.structured === undefined)
      throw new Error('fixture For Each body missing');
    Object.assign(mutatedLoop.structured.body.nodes[0]?.executor ?? {}, {
      version: 2,
    });
    expect(() =>
      parseWorkflowExecutable({
        envelope: mutated,
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('applies port validation recursively and selects body-only definitions', () => {
    const catalog = composeExecutableCatalog(nodeCatalog({ forEach: true }));
    const changed = composeExecutableCatalog(
      nodeCatalog({ forEach: true, mutateSet: true }),
    );
    expect(
      buildWorkflowExecutable({ graph: forEachGraph(), catalog: changed })
        .checksum,
    ).not.toBe(
      buildWorkflowExecutable({ graph: forEachGraph(), catalog }).checksum,
    );

    const invalid = structuredClone(forEachGraph());
    const loop = invalid.nodes.find(({ id }) => id === 'loop');
    if (loop === undefined || !('structured' in loop))
      throw new Error('fixture For Each body missing');
    Object.assign(loop.structured.body.edges[0]?.source ?? {}, {
      port: 'missing',
    });
    expect(() => buildWorkflowExecutable({ graph: invalid, catalog })).toThrow(
      expect.objectContaining({ code: 'executable_invalid' }),
    );
  });

  it('rejects unpinned expression policy versions', () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const expression = structuredClone(graph());
    Object.assign(expression.nodes[1], {
      inputMappings: {
        bad: {
          kind: 'expression',
          language: 'jsonata',
          expression: '$.runInput',
          policyVersion: 2,
        },
      },
    });
    expect(() =>
      buildWorkflowExecutable({ graph: expression, catalog }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('enforces exact V2 byte accounting before canonical allocation', () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const compiled = buildWorkflowExecutable({ graph: graph(), catalog });
    const exact = structuredClone(compiled.envelope);
    const set = exact.graph.nodes.find(({ id }) => id === 'set');
    if (set === undefined) throw new Error('fixture set node missing');
    Object.assign(set, { config: { padding: '' } });
    const encoder = new TextEncoder();
    const baseBytes = encoder.encode(JSON.stringify(exact)).byteLength;
    Object.assign(set, {
      config: {
        padding: 'x'.repeat(WORKFLOW_EXECUTABLE_LIMITS.bytes - baseBytes),
      },
    });
    expect(encoder.encode(JSON.stringify(exact)).byteLength).toBe(
      WORKFLOW_EXECUTABLE_LIMITS.bytes,
    );
    expect(
      parseWorkflowExecutable({ envelope: exact, catalog: catalog })
        .schemaVersion,
    ).toBe(2);
    const over = structuredClone(exact);
    const overSet = over.graph.nodes.find(({ id }) => id === 'set');
    if (overSet === undefined) throw new Error('fixture set node missing');
    Object.assign(overSet, { config: { padding: 'x'.repeat(4 * 1_048_576) } });
    expect(() =>
      parseWorkflowExecutable({ envelope: over, catalog: catalog }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('rejects a publish-valid near-limit graph when V2 pins exceed the envelope limit', () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const nearLimit = structuredClone(graph());
    const set = nearLimit.nodes.find(({ id }) => id === 'set');
    if (set === undefined) throw new Error('fixture set node missing');
    Object.assign(set, { config: { padding: '' } });
    const encoder = new TextEncoder();
    const baseBytes = encoder.encode(JSON.stringify(nearLimit)).byteLength;
    Object.assign(set, {
      config: {
        padding: 'x'.repeat(WORKFLOW_EXECUTABLE_LIMITS.bytes - baseBytes - 1),
      },
    });
    expect(encoder.encode(JSON.stringify(nearLimit)).byteLength).toBe(
      WORKFLOW_EXECUTABLE_LIMITS.bytes - 1,
    );
    expect(() =>
      buildWorkflowExecutable({ graph: nearLimit, catalog }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('compiles a chain at the node limit within the bounded publication budget', () => {
    const catalog = composeExecutableCatalog(nodeCatalog());
    const middle = Array.from(
      { length: WORKFLOW_GRAPH_LIMITS.nodes - 2 },
      (_, index) => ({
        id: `set-${String(index)}`,
        definition: { key: 'core.set', version: 1 } as const,
        position: { x: index + 1, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      }),
    );
    const nodes = [
      { ...graph().nodes[0], inputMappings: {} },
      ...middle,
      { ...graph().nodes[2], inputMappings: {} },
    ];
    const edges = Array.from({ length: nodes.length - 1 }, (_, index) => ({
      id: `edge-${String(index)}`,
      source: { nodeId: nodes[index]?.id, port: 'out' },
      target: { nodeId: nodes[index + 1]?.id, port: 'in' },
    }));
    const startedAt = performance.now();

    const executable = buildWorkflowExecutable({
      graph: {
        schemaVersion: 1,
        settings: { maxRunDurationMs: 60_000 },
        nodes,
        edges,
      },
      catalog,
    });

    expect(executable.envelope.graph.nodes).toHaveLength(
      WORKFLOW_GRAPH_LIMITS.nodes,
    );
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});
