import { describe, expect, it } from 'vitest';
import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  parseWorkflowExecutable,
  verifyWorkflowExecutable,
  WORKFLOW_EXECUTABLE_LIMITS,
} from '../../../src/index.js';
import {
  nodeCatalog,
  graph,
  forEachGraph,
} from '../../support/executable-workflow.js';
describe('workflow executable identity', () => {
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
  it('enforces exact executable byte accounting before canonical allocation', () => {
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
      parseWorkflowExecutable({ envelope: exact, catalog: catalog }).graph,
    ).toEqual(exact.graph);
    const over = structuredClone(exact);
    const overSet = over.graph.nodes.find(({ id }) => id === 'set');
    if (overSet === undefined) throw new Error('fixture set node missing');
    Object.assign(overSet, { config: { padding: 'x'.repeat(4 * 1_048_576) } });
    expect(() =>
      parseWorkflowExecutable({ envelope: over, catalog: catalog }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });
  it('rejects a publish-valid near-limit graph when executable pins exceed the envelope limit', () => {
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
