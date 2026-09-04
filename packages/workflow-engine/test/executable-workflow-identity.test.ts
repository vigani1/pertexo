import { describe, expect, it } from 'vitest';

import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  computeWorkflowExecutableChecksumV2,
  createExecutableCompatibilityReleaseSupport,
  createExecutableCompatibilityReleaseHistory,
  describeExecutableCompatibilityRelease,
  parseWorkflowExecutableV2,
  verifyWorkflowExecutableV2,
  WORKFLOW_EXECUTABLE_LIMITS_V2,
  nodeRelease,
  conditionGraph,
  switchGraph,
  parallelGraph,
  directPairedParallelGraph,
  graph,
  forEachGraph,
} from './executable-workflow.fixtures.js';

describe('workflow executable V2 identity', () => {
  it('rejects a Condition edge through an undeclared output port', () => {
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ condition: true }),
    );

    expect(() =>
      buildWorkflowExecutableV2({
        graph: conditionGraph('out'),
        release,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('rejects Condition branches that reconverge before Merge exists', () => {
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ condition: true }),
    );
    const reconverging = conditionGraph('true');

    expect(() =>
      buildWorkflowExecutableV2({
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
        release,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('rejects Switch edges through unconfigured cases and pre-Merge reconvergence', () => {
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ switch: true }),
    );
    expect(() =>
      buildWorkflowExecutableV2({
        graph: switchGraph('case-03'),
        release,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));

    const reconverging = switchGraph('case-02');
    expect(() =>
      buildWorkflowExecutableV2({
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
        release,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('requires every declared Parallel branch exactly once without pre-Merge reconvergence', () => {
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ parallel: true }),
    );
    expect(() =>
      buildWorkflowExecutableV2({
        graph: parallelGraph('branch-03'),
        release,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    const missing = parallelGraph();
    expect(() =>
      buildWorkflowExecutableV2({
        graph: { ...missing, edges: missing.edges.slice(0, 2) },
        release,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    const reconverging = parallelGraph();
    expect(() =>
      buildWorkflowExecutableV2({
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
        release,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('accepts direct Parallel branches into their paired Merge inputs', () => {
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ parallel: true, merge: true }),
    );
    expect(() =>
      buildWorkflowExecutableV2({
        graph: directPairedParallelGraph(),
        release,
      }),
    ).not.toThrow();
  });

  it('describes the exact durable compatibility authority for a deployment artifact', () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const description = describeExecutableCompatibilityRelease(release);

    expect(description.epoch).toBe(1);
    expect(description.fingerprint).toBe(release.fingerprint);
    expect(description.catalogJson).toContain(
      '"domain":"pertexo.node-compatibility-release"',
    );
  });

  it('supports only one validated current-to-target rolling overlap', () => {
    const current = composeExecutableCompatibilityRelease(
      nodeRelease({ epoch: 1 }),
    );
    const target = composeExecutableCompatibilityRelease(
      nodeRelease({ epoch: 2, extraPolicyVersion: 1 }),
    );
    const support = createExecutableCompatibilityReleaseSupport([
      current,
      target,
    ]);

    expect(support.descriptions).toEqual([
      describeExecutableCompatibilityRelease(current),
      describeExecutableCompatibilityRelease(target),
    ]);
    expect(support.resolve(current.epoch, current.fingerprint)).toEqual(
      current,
    );
    expect(support.resolve(target.epoch, target.fingerprint)).toEqual(target);
    expect(() => support.resolve(3, target.fingerprint)).toThrow(
      'not supported by this artifact',
    );
    expect(
      buildWorkflowExecutableV2({ graph: graph(), release: current }).checksum,
    ).toBe(
      buildWorkflowExecutableV2({ graph: graph(), release: target }).checksum,
    );
    expect(() =>
      createExecutableCompatibilityReleaseSupport([
        current,
        composeExecutableCompatibilityRelease(
          nodeRelease({ epoch: 3, extraPolicyVersion: 2 }),
        ),
      ]),
    ).toThrow('successor');
    expect(() =>
      createExecutableCompatibilityReleaseSupport([
        current,
        target,
        composeExecutableCompatibilityRelease(
          nodeRelease({ epoch: 3, extraPolicyVersion: 2 }),
        ),
      ]),
    ).toThrow('one rolling overlap');
  });

  it('keeps retained executable history separate from the rolling readiness overlap', () => {
    const releases = [
      composeExecutableCompatibilityRelease(nodeRelease({ epoch: 1 })),
      composeExecutableCompatibilityRelease(
        nodeRelease({ epoch: 2, extraPolicyVersion: 1 }),
      ),
      composeExecutableCompatibilityRelease(
        nodeRelease({ epoch: 3, extraPolicyVersion: 2 }),
      ),
    ];
    const history = createExecutableCompatibilityReleaseHistory(releases);

    expect(history.descriptions.map(({ epoch }) => epoch)).toEqual([1, 2, 3]);
    for (const release of releases)
      expect(history.resolve(release.epoch, release.fingerprint)).toEqual(
        release,
      );
    expect(() =>
      createExecutableCompatibilityReleaseHistory([
        releases[0],
        composeExecutableCompatibilityRelease(nodeRelease({ epoch: 4 })),
      ]),
    ).toThrow('successor');
  });

  it('composes engine-owned policies and produces the pre-publication golden checksum', () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const compiled = buildWorkflowExecutableV2({ graph: graph(), release });
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
      'wf:v2:sha256:83af8d0f5a0827ce0036124d7bcfb2da4935b2f633d1f5f92d3fc3873f0faeff',
    );
    expect(
      verifyWorkflowExecutableV2({
        ...compiled,
        admissionRelease: release,
      }),
    ).toEqual(compiled);
  });

  it('is invariant to graph order, release provenance, and unrelated catalog additions', () => {
    const firstRelease = composeExecutableCompatibilityRelease(nodeRelease());
    const laterRelease = composeExecutableCompatibilityRelease(
      nodeRelease({ epoch: 2, unrelated: true }),
    );
    const first = buildWorkflowExecutableV2({
      graph: graph(),
      release: firstRelease,
    });
    const later = buildWorkflowExecutableV2({
      graph: graph(true),
      release: laterRelease,
    });
    expect(later.checksum).toBe(first.checksum);
    expect(later.envelope.compatibilityReleaseFingerprint).not.toBe(
      first.envelope.compatibilityReleaseFingerprint,
    );
    const explicitFalse = structuredClone(graph());
    explicitFalse.nodes.forEach((node) =>
      Object.assign(node, { disabled: false }),
    );
    const explicit = buildWorkflowExecutableV2({
      graph: explicitFalse,
      release: firstRelease,
    });
    expect(explicit.checksum).toBe(first.checksum);
    expect(first.envelope.graph.nodes.every(({ disabled }) => !disabled)).toBe(
      true,
    );
  });

  it('changes identity for a selected compatibility mutation', () => {
    const original = composeExecutableCompatibilityRelease(nodeRelease());
    const changed = composeExecutableCompatibilityRelease(
      nodeRelease({ epoch: 2, mutateSet: true }),
    );
    expect(
      buildWorkflowExecutableV2({ graph: graph(), release: changed }).checksum,
    ).not.toBe(
      buildWorkflowExecutableV2({ graph: graph(), release: original }).checksum,
    );
  });

  it('pins side-effect class into behavior identity and rejects a mutated pin', () => {
    const safeRelease = composeExecutableCompatibilityRelease(nodeRelease());
    const idempotentRelease = composeExecutableCompatibilityRelease(
      nodeRelease({ setRetryClass: 'idempotent-with-key' }),
    );
    const safe = buildWorkflowExecutableV2({
      graph: graph(),
      release: safeRelease,
    });
    const idempotent = buildWorkflowExecutableV2({
      graph: graph(),
      release: idempotentRelease,
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
    expect(computeWorkflowExecutableChecksumV2(mutated)).not.toBe(
      safe.checksum,
    );
    expect(() =>
      parseWorkflowExecutableV2({
        envelope: mutated,
        admissionRelease: safeRelease,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));

    for (const invalidClass of ['idempotent-with-key', 'unknown']) {
      const wrong = structuredClone(safe.envelope);
      const wrongSet = wrong.graph.nodes.find(({ id }) => id === 'set');
      if (wrongSet === undefined) throw new Error('fixture set node missing');
      Object.assign(wrongSet, { sideEffectClass: invalidClass });
      expect(() =>
        parseWorkflowExecutableV2({
          envelope: wrong,
          admissionRelease: safeRelease,
        }),
      ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    }

    const missing = structuredClone(safe.envelope);
    const missingSet = missing.graph.nodes.find(({ id }) => id === 'set');
    if (missingSet === undefined) throw new Error('fixture set node missing');
    Reflect.deleteProperty(missingSet, 'sideEffectClass');
    expect(() =>
      parseWorkflowExecutableV2({
        envelope: missing,
        admissionRelease: safeRelease,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));

    const driftedCurrent = composeExecutableCompatibilityRelease(
      nodeRelease({ epoch: 2, setRetryClass: 'idempotent-with-key' }),
    );
    expect(() =>
      parseWorkflowExecutableV2({
        envelope: safe.envelope,
        admissionRelease: safeRelease,
        currentRelease: driftedCurrent,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('maps all manifest retry classes once into pinned ADR 007 vocabulary', () => {
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({
        manualRetryClass: 'unsafe',
        setRetryClass: 'idempotent-with-key',
      }),
    );
    expect(
      buildWorkflowExecutableV2({
        graph: graph(),
        release,
      }).envelope.graph.nodes.map(({ sideEffectClass }) => sideEffectClass),
    ).toEqual(['unsafe', 'idempotent_with_key', 'safe']);
  });

  it('executes retained exact pins under a later release without rewriting provenance', () => {
    const admission = composeExecutableCompatibilityRelease(nodeRelease());
    const current = composeExecutableCompatibilityRelease(
      nodeRelease({ epoch: 2, executorLifecycle: 'retained' }),
    );
    const compiled = buildWorkflowExecutableV2({
      graph: graph(),
      release: admission,
    });
    const retained = parseWorkflowExecutableV2({
      envelope: compiled.envelope,
      admissionRelease: admission,
      currentRelease: current,
    });
    expect(retained.compatibilityReleaseEpoch).toBe(1);
    expect(
      retained.graph.nodes.map(({ sideEffectClass }) => sideEffectClass),
    ).toEqual(['safe', 'safe', 'safe']);
    expect(() =>
      buildWorkflowExecutableV2({ graph: graph(), release: current }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    const blocked = composeExecutableCompatibilityRelease(
      nodeRelease({ epoch: 3, executorLifecycle: 'retirement_blocked' }),
    );
    expect(() =>
      parseWorkflowExecutableV2({
        envelope: compiled.envelope,
        admissionRelease: admission,
        currentRelease: blocked,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    const retirementBlocked = parseWorkflowExecutableV2({
      envelope: compiled.envelope,
      admissionRelease: admission,
      currentRelease: blocked,
      execution: { alreadyAdmitted: true },
    });
    expect(retirementBlocked.compatibilityReleaseEpoch).toBe(1);
    expect(
      retirementBlocked.graph.nodes.map(
        ({ sideEffectClass }) => sideEffectClass,
      ),
    ).toEqual(['safe', 'safe', 'safe']);
    expect(() =>
      parseWorkflowExecutableV2({
        envelope: compiled.envelope,
        admissionRelease: admission,
        currentRelease: composeExecutableCompatibilityRelease(
          nodeRelease({ epoch: 4, driftCapability: true }),
        ),
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    expect(() =>
      parseWorkflowExecutableV2({
        envelope: compiled.envelope,
        admissionRelease: admission,
        execution: { alreadyAdmitted: 'yes' as unknown as boolean },
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('fails closed for mutated pins, checksum, malformed envelopes, and V1 input', () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const compiled = buildWorkflowExecutableV2({ graph: graph(), release });
    const mutated = structuredClone(compiled.envelope);
    const set = mutated.graph.nodes.find(({ id }) => id === 'set');
    if (set === undefined) throw new Error('fixture set node missing');
    Object.assign(set.executor, { version: 2 });
    expect(() =>
      parseWorkflowExecutableV2({
        envelope: mutated,
        admissionRelease: release,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    expect(() =>
      verifyWorkflowExecutableV2({
        envelope: compiled.envelope,
        checksum: compiled.checksum.replace(/.$/u, '0'),
        admissionRelease: release,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    expect(() =>
      parseWorkflowExecutableV2({
        envelope: { ...compiled.envelope, unknown: true },
        admissionRelease: release,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    expect(() =>
      parseWorkflowExecutableV2({
        envelope: { schemaVersion: 1 },
        admissionRelease: release,
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
      parseWorkflowExecutableV2({
        envelope: hostile,
        admissionRelease: release,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
    expect(trapCalls).toBe(0);
  });

  it('deduplicates repeated definition identities in selection', () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const base = graph();
    const repeated = {
      ...base,
      nodes: [
        base.nodes[0],
        base.nodes[1],
        { ...base.nodes[1], id: 'set-again', position: { x: 15, y: 0 } },
        {
          ...base.nodes[2],
          inputMappings: {
            result: {
              kind: 'node_output',
              nodeId: 'set-again',
              path: '$',
            },
          },
        },
      ],
      edges: [
        base.edges[0],
        {
          id: 'set-set-again',
          source: { nodeId: 'set', port: 'out' },
          target: { nodeId: 'set-again', port: 'in' },
        },
        {
          id: 'set-again-terminate',
          source: { nodeId: 'set-again', port: 'out' },
          target: { nodeId: 'terminate', port: 'in' },
        },
      ],
    } as const;
    expect(
      buildWorkflowExecutableV2({ graph: repeated, release }).checksum,
    ).toMatch(/^wf:v2:sha256:[a-f0-9]{64}$/u);
  });

  it('recursively pins, orders, checksums, parses, and verifies For Each bodies', () => {
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ forEach: true }),
    );
    const compiled = buildWorkflowExecutableV2({
      graph: forEachGraph(true),
      release,
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
      buildWorkflowExecutableV2({ graph: forEachGraph(), release }).checksum,
    );
    expect(
      verifyWorkflowExecutableV2({ ...compiled, admissionRelease: release }),
    ).toEqual(compiled);

    const mutated = structuredClone(compiled.envelope);
    const mutatedLoop = mutated.graph.nodes.find(({ id }) => id === 'loop');
    if (mutatedLoop?.structured === undefined)
      throw new Error('fixture For Each body missing');
    Object.assign(mutatedLoop.structured.body.nodes[0]?.executor ?? {}, {
      version: 2,
    });
    expect(() =>
      parseWorkflowExecutableV2({
        envelope: mutated,
        admissionRelease: release,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('applies port validation recursively and selects body-only definitions', () => {
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ forEach: true }),
    );
    const changed = composeExecutableCompatibilityRelease(
      nodeRelease({ epoch: 2, forEach: true, mutateSet: true }),
    );
    expect(
      buildWorkflowExecutableV2({ graph: forEachGraph(), release: changed })
        .checksum,
    ).not.toBe(
      buildWorkflowExecutableV2({ graph: forEachGraph(), release }).checksum,
    );

    const invalid = structuredClone(forEachGraph());
    const loop = invalid.nodes.find(({ id }) => id === 'loop');
    if (loop === undefined || !('structured' in loop))
      throw new Error('fixture For Each body missing');
    Object.assign(loop.structured.body.edges[0]?.source ?? {}, {
      port: 'missing',
    });
    expect(() =>
      buildWorkflowExecutableV2({ graph: invalid, release }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('rejects unpinned expression policy versions', () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
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
      buildWorkflowExecutableV2({ graph: expression, release }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('enforces exact V2 byte accounting before canonical allocation', () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const compiled = buildWorkflowExecutableV2({ graph: graph(), release });
    const exact = structuredClone(compiled.envelope);
    const set = exact.graph.nodes.find(({ id }) => id === 'set');
    if (set === undefined) throw new Error('fixture set node missing');
    Object.assign(set, { config: { padding: '' } });
    const encoder = new TextEncoder();
    const baseBytes = encoder.encode(JSON.stringify(exact)).byteLength;
    Object.assign(set, {
      config: {
        padding: 'x'.repeat(WORKFLOW_EXECUTABLE_LIMITS_V2.bytes - baseBytes),
      },
    });
    expect(encoder.encode(JSON.stringify(exact)).byteLength).toBe(
      WORKFLOW_EXECUTABLE_LIMITS_V2.bytes,
    );
    expect(
      parseWorkflowExecutableV2({ envelope: exact, admissionRelease: release })
        .schemaVersion,
    ).toBe(2);
    const over = structuredClone(exact);
    const overSet = over.graph.nodes.find(({ id }) => id === 'set');
    if (overSet === undefined) throw new Error('fixture set node missing');
    Object.assign(overSet, { config: { padding: 'x'.repeat(4 * 1_048_576) } });
    expect(() =>
      parseWorkflowExecutableV2({ envelope: over, admissionRelease: release }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('rejects a publish-valid near-limit graph when V2 pins exceed the envelope limit', () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const nearLimit = structuredClone(graph());
    const set = nearLimit.nodes.find(({ id }) => id === 'set');
    if (set === undefined) throw new Error('fixture set node missing');
    Object.assign(set, { config: { padding: '' } });
    const encoder = new TextEncoder();
    const baseBytes = encoder.encode(JSON.stringify(nearLimit)).byteLength;
    Object.assign(set, {
      config: {
        padding: 'x'.repeat(
          WORKFLOW_EXECUTABLE_LIMITS_V2.bytes - baseBytes - 1,
        ),
      },
    });
    expect(encoder.encode(JSON.stringify(nearLimit)).byteLength).toBe(
      WORKFLOW_EXECUTABLE_LIMITS_V2.bytes - 1,
    );
    expect(() =>
      buildWorkflowExecutableV2({ graph: nearLimit, release }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('compiles a large 300-node chain within the bounded publication budget', () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const middle = Array.from({ length: 298 }, (_, index) => ({
      id: `set-${String(index)}`,
      definition: { key: 'core.set', version: 1 } as const,
      position: { x: index + 1, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    }));
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

    const executable = buildWorkflowExecutableV2({
      graph: {
        schemaVersion: 1,
        settings: { maxRunDurationMs: 60_000 },
        nodes,
        edges,
      },
      release,
    });

    expect(executable.envelope.graph.nodes).toHaveLength(300);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});
