import {
  createRegistryRelease,
  type ExecutorLifecycle,
  type NodeManifest,
  type PolicyReference,
  type RegistryRelease,
} from '@pertexo/node-sdk';
import { describe, expect, it } from 'vitest';

import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  parseWorkflowExecutableV2,
  verifyWorkflowExecutableV2,
  WORKFLOW_EXECUTABLE_LIMITS_V2,
} from '../src/index.js';

const boundedPolicy = { key: 'node.json.bounded', version: 1 } as const;
const jsonataPolicy = { key: 'jsonata.restricted', version: 1 } as const;
const schema = { type: 'object', additionalProperties: true } as const;

function manifest(
  key: 'core.manual' | 'core.set' | 'core.terminate' | 'test.unrelated',
  policies: readonly PolicyReference[] = [boundedPolicy],
): NodeManifest {
  return {
    schemaVersion: 1,
    definition: { key, version: 1 },
    family:
      key === 'core.manual'
        ? 'trigger'
        : key === 'core.terminate'
          ? 'output'
          : 'transform',
    configVersion: 1,
    configSchema: schema,
    inputSchema: schema,
    outputSchema: schema,
    ports: {
      inputs: key === 'core.manual' ? [] : ['in'],
      outputs: key === 'core.terminate' ? [] : ['out'],
    },
    credentialRequirements: [],
    connectionRequirements: [],
    retryClass: 'safe',
    resourceClass: 'cpu',
    capabilities: key === 'core.terminate' ? ['terminates_run'] : [],
    lifecycle: 'active',
    executor: { key, version: 1 },
    executorAbi: 1,
    policyReferences: policies,
  };
}

function nodeRelease(input?: {
  readonly epoch?: number;
  readonly executorLifecycle?: ExecutorLifecycle;
  readonly mutateSet?: boolean;
  readonly unrelated?: boolean;
  readonly driftCapability?: boolean;
}): RegistryRelease {
  const definitions = [
    manifest('core.manual'),
    manifest(
      'core.set',
      input?.mutateSet ? [jsonataPolicy] : [boundedPolicy, jsonataPolicy],
    ),
    manifest('core.terminate'),
    ...(input?.unrelated ? [manifest('test.unrelated')] : []),
  ];
  if (input?.driftCapability) {
    const set = definitions.find(
      ({ definition }) => definition.key === 'core.set',
    );
    if (set !== undefined) Object.assign(set, { capabilities: ['drifted'] });
  }
  return createRegistryRelease({
    epoch: input?.epoch ?? 1,
    definitions,
    executors: definitions.map((definition) => ({
      executor: definition.executor,
      abiVersion: 1,
      definitions: [definition.definition],
      lifecycle: input?.executorLifecycle ?? 'active',
      policyReferences: definition.policyReferences,
    })),
    policies: [boundedPolicy, jsonataPolicy],
  });
}

function graph(reverse = false) {
  const nodes = [
    {
      id: 'manual',
      definition: { key: 'core.manual', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    },
    {
      id: 'set',
      definition: { key: 'core.set', version: 1 },
      position: { x: 10, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {
        literal: { kind: 'literal', value: 1 },
        fromRun: { kind: 'run_input', path: '$.name' },
      },
      connectionRefs: {},
    },
    {
      id: 'terminate',
      definition: { key: 'core.terminate', version: 1 },
      position: { x: 20, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {
        result: { kind: 'node_output', nodeId: 'set', path: '$' },
      },
      connectionRefs: {},
    },
  ] as const;
  const edges = [
    {
      id: 'manual-set',
      source: { nodeId: 'manual', port: 'out' },
      target: { nodeId: 'set', port: 'in' },
    },
    {
      id: 'set-terminate',
      source: { nodeId: 'set', port: 'out' },
      target: { nodeId: 'terminate', port: 'in' },
    },
  ] as const;
  return {
    schemaVersion: 1,
    settings: { maxRunDurationMs: 60_000 },
    nodes: reverse ? [...nodes].reverse() : nodes,
    edges: reverse ? [...edges].reverse() : edges,
  };
}

describe('workflow executable V2 identity', () => {
  it('composes engine-owned policies and produces the retained golden checksum', () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const compiled = buildWorkflowExecutableV2({ graph: graph(), release });
    expect(compiled.envelope.graph.nodes.map(({ id }) => id)).toEqual([
      'manual',
      'set',
      'terminate',
    ]);
    expect(compiled.checksum).toBe(
      'wf:v2:sha256:5bd46722bf6e3a0b436a65a0acf18479772d40b33589f1e5a565bb24db470bf2',
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

  it('executes retained exact pins under a later release without rewriting provenance', () => {
    const admission = composeExecutableCompatibilityRelease(nodeRelease());
    const current = composeExecutableCompatibilityRelease(
      nodeRelease({ epoch: 2, executorLifecycle: 'retained' }),
    );
    const compiled = buildWorkflowExecutableV2({
      graph: graph(),
      release: admission,
    });
    expect(
      parseWorkflowExecutableV2({
        envelope: compiled.envelope,
        admissionRelease: admission,
        currentRelease: current,
      }).compatibilityReleaseEpoch,
    ).toBe(1);
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
    expect(
      parseWorkflowExecutableV2({
        envelope: compiled.envelope,
        admissionRelease: admission,
        currentRelease: blocked,
        execution: { alreadyAdmitted: true },
      }).compatibilityReleaseEpoch,
    ).toBe(1);
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
        base.nodes[2],
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
    };
    expect(
      buildWorkflowExecutableV2({ graph: repeated, release }).checksum,
    ).toMatch(/^wf:v2:sha256:[a-f0-9]{64}$/u);
  });

  it('rejects structured nodes and unpinned expression policy versions', () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const structured = structuredClone(graph()) as Record<string, unknown>;
    const nodes = structured.nodes;
    if (
      !Array.isArray(nodes) ||
      typeof nodes[1] !== 'object' ||
      nodes[1] === null
    )
      throw new Error('fixture set node missing');
    Object.assign(nodes[1], {
      structured: {
        kind: 'for_each',
        maxIterations: 1,
        maxConcurrency: 1,
        body: {
          schemaVersion: 1,
          settings: {},
          nodes: [],
          edges: [],
          inputPorts: [],
          outputPorts: [],
        },
      },
    });
    expect(() =>
      buildWorkflowExecutableV2({ graph: structured, release }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
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
});
