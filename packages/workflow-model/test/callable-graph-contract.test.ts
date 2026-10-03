import { describe, expect, it } from 'vitest';

import {
  workflowCallableGraphSchemaV2,
  workflowGraphStructuralSchemaV2,
} from '../src/callable-graph-contract.js';
import { workflowGraphSchema } from '../src/graph-contract.js';

const emptyType = () => ({ type: 'object', properties: {}, required: [] });
const declaration = () => ({
  schemaVersion: 1,
  input: emptyType(),
  result: emptyType(),
  resultSelector: { kind: 'node_output', nodeId: 'result', path: '$' },
});
const graph = (schemaVersion = 2) => ({
  schemaVersion,
  nodes: [] as unknown[],
  edges: [],
  settings: {},
});
const node = (body?: unknown) => ({
  id: 'loop',
  definition: { key: 'core.for_each', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
  ...(body === undefined
    ? {}
    : {
        structured: {
          kind: 'for_each',
          maxIterations: 1,
          maxConcurrency: 1,
          body,
        },
      }),
});
const body = (schemaVersion: number, nodes: unknown[] = []) => ({
  ...graph(schemaVersion),
  nodes,
  inputPorts: ['item'],
  outputPorts: ['result'],
});

describe('explicit callable graph V2 grammar', () => {
  it('keeps retained V1 grammar exact and rejects V2/new metadata there', () => {
    expect(workflowGraphSchema.parse(graph(1))).toEqual(graph(1));
    expect(workflowGraphSchema.safeParse(graph()).success).toBe(false);
    expect(
      workflowGraphSchema.safeParse({ ...graph(1), callable: declaration() })
        .success,
    ).toBe(false);
    expect(
      workflowGraphSchema.safeParse({ ...graph(1), nodes: [node(body(2))] })
        .success,
    ).toBe(false);
    expect(workflowCallableGraphSchemaV2.safeParse(graph(1)).success).toBe(
      false,
    );
  });
  it('admits V2 with optional explicit callable declaration and closed object contracts', () => {
    expect(workflowCallableGraphSchemaV2.parse(graph())).toEqual(graph());
    const input = { ...graph(), callable: declaration() };
    expect(workflowCallableGraphSchemaV2.parse(input)).toEqual(input);
    expect(workflowGraphStructuralSchemaV2.parse(input)).toEqual(input);
    expect(
      workflowCallableGraphSchemaV2.safeParse({
        ...input,
        callable: { ...declaration(), input: { type: 'string' } },
      }).success,
    ).toBe(false);
  });
  it.each([
    { ...graph(), extra: true },
    { ...graph(), callable: { ...declaration(), schemaVersion: 2 } },
    { ...graph(), callable: { ...declaration(), additionalProperties: true } },
    {
      ...graph(),
      callable: {
        ...declaration(),
        resultSelector: {
          kind: 'node_output',
          nodeId: 'result',
          path: '$',
          extra: true,
        },
      },
    },
    {
      ...graph(),
      callable: {
        ...declaration(),
        result: {
          type: 'object',
          properties: { constructor: { type: 'string' } },
          required: [],
        },
      },
    },
  ])('rejects strict-field and descriptor violations %#', (input) => {
    expect(workflowCallableGraphSchemaV2.safeParse(input).success).toBe(false);
  });
  it('reuses the descriptor depth bound inside the guarded root', () => {
    let type: unknown = { type: 'string' };
    for (let index = 0; index < 8; index += 1)
      type = { type: 'array', items: type, maxItems: 1 };
    expect(
      workflowCallableGraphSchemaV2.safeParse({
        ...graph(),
        callable: {
          ...declaration(),
          input: { type: 'object', properties: { deep: type }, required: [] },
        },
      }).success,
    ).toBe(false);
  });
  it('admits mixed V1/V2 bodies without widening the V1 body grammar', () => {
    const input = {
      ...graph(),
      nodes: [node(body(1)), node(body(2, [node(body(1)), node(body(2))]))],
    };
    expect(workflowCallableGraphSchemaV2.parse(input)).toEqual(input);
    expect(
      workflowCallableGraphSchemaV2.safeParse({
        ...graph(),
        nodes: [node(body(1, [node(body(2))]))],
      }).success,
    ).toBe(false);
  });
  it.each([1, 2])(
    'rejects callable declarations in V%s structured bodies',
    (version) => {
      expect(
        workflowCallableGraphSchemaV2.safeParse({
          ...graph(),
          nodes: [node({ ...body(version), callable: declaration() })],
        }).success,
      ).toBe(false);
    },
  );
  it('preserves admitted own __proto__ literals and input mapping keys', () => {
    const literal: unknown = JSON.parse(
      '{"__proto__":{"safe":true},"nested":[{"__proto__":1}]}',
    );
    const mappings: unknown = JSON.parse(
      '{"__proto__":{"kind":"literal","value":{"__proto__":2}}}',
    );
    const parsed = workflowCallableGraphSchemaV2.parse({
      ...graph(),
      nodes: [{ ...node(), inputMappings: mappings }],
      callable: {
        ...declaration(),
        resultSelector: { kind: 'literal', value: literal },
      },
    });
    expect(parsed.callable?.resultSelector).toEqual({
      kind: 'literal',
      value: literal,
    });
    expect(parsed.nodes[0]?.inputMappings).toEqual(mappings);
    if (parsed.callable?.resultSelector.kind === 'literal') {
      expect(
        Object.hasOwn(
          parsed.callable.resultSelector.value as object,
          '__proto__',
        ),
      ).toBe(true);
    }
    expect(Object.prototype).not.toHaveProperty('safe');
  });
  it('enforces the existing literal JSON depth bound for result selectors', () => {
    let value: unknown = null;
    for (let index = 0; index < 65; index += 1) value = [value];
    expect(
      workflowCallableGraphSchemaV2.safeParse({
        ...graph(),
        callable: {
          ...declaration(),
          resultSelector: { kind: 'literal', value },
        },
      }).success,
    ).toBe(false);
    expect(
      workflowCallableGraphSchemaV2.safeParse({
        ...graph(),
        callable: {
          ...declaration(),
          resultSelector: { kind: 'literal', value: NaN },
        },
      }).success,
    ).toBe(false);
  });
  it('bounds aggregate nodes across all bodies', () => {
    expect(
      workflowCallableGraphSchemaV2.safeParse({
        ...graph(),
        nodes: [
          node(
            body(
              2,
              Array.from({ length: 1_000 }, () => node()),
            ),
          ),
        ],
      }).success,
    ).toBe(false);
  });
  it('rejects hostile getters, cycles and throwing reflection before structural parsing', () => {
    let reads = 0;
    const getter = Object.defineProperty(graph(), 'callable', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('secret');
      },
    });
    const cycle: Record<string, unknown> = graph();
    cycle.callable = cycle;
    const proxy = new Proxy(graph(), {
      ownKeys() {
        throw new Error('secret');
      },
    });
    for (const input of [getter, cycle, proxy]) {
      const result = workflowCallableGraphSchemaV2.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).not.toContain('secret');
    }
    expect(reads).toBe(0);
  });
});
