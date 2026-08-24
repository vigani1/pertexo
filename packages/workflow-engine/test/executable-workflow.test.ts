import {
  createRegistryRelease,
  type ExecutorLifecycle,
  type NodeManifest,
  type PolicyReference,
  type RegistryRelease,
} from '@pertexo/node-sdk';
import { NodeExecutionAbortedError } from '@pertexo/node-sdk/server';
import { describe, expect, it } from 'vitest';

import * as productionEngine from '../src/index.js';
import * as testingEngine from '../src/testing.js';

import {
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  computeWorkflowExecutableChecksumV2,
  createExecutableCompatibilityReleaseSupport,
  createExecutableCompatibilityReleaseHistory,
  createCheckpoint,
  createCheckpointV2,
  describeExecutableCompatibilityRelease,
  executeNodeAttempt,
  invocationKey,
  parseWorkflowExecutableV2,
  providerIdempotencyKey,
  resolveSingleNodePreviewInput,
  verifyWorkflowExecutableV2,
  WORKFLOW_EXECUTABLE_LIMITS_V2,
} from '../src/index.js';

const boundedPolicy = { key: 'node.json.bounded', version: 1 } as const;
const jsonataPolicy = { key: 'jsonata.restricted', version: 1 } as const;
const schema = { type: 'object', additionalProperties: true } as const;

function manifest(
  key:
    | 'core.condition'
    | 'core.manual'
    | 'core.merge'
    | 'core.parallel'
    | 'core.set'
    | 'core.switch'
    | 'core.terminate'
    | 'test.unrelated',
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
          : key === 'core.condition' ||
              key === 'core.switch' ||
              key === 'core.parallel' ||
              key === 'core.merge'
            ? 'logic'
            : 'transform',
    configVersion: 1,
    configSchema: schema,
    inputSchema: schema,
    outputSchema: schema,
    ports: {
      inputs:
        key === 'core.manual'
          ? []
          : key === 'core.merge'
            ? [
                'branch-01',
                'branch-02',
                'branch-03',
                'branch-04',
                'branch-05',
                'branch-06',
                'branch-07',
                'branch-08',
                'branch-09',
                'branch-10',
                'branch-11',
                'branch-12',
                'branch-13',
                'branch-14',
                'branch-15',
                'branch-16',
              ]
            : ['in'],
      outputs:
        key === 'core.terminate'
          ? []
          : key === 'core.condition'
            ? ['true', 'false']
            : key === 'core.switch'
              ? [
                  'case-01',
                  'case-02',
                  'case-03',
                  'case-04',
                  'case-05',
                  'case-06',
                  'case-07',
                  'case-08',
                  'case-09',
                  'case-10',
                  'case-11',
                  'case-12',
                  'case-13',
                  'case-14',
                  'case-15',
                  'case-16',
                  'default',
                ]
              : key === 'core.parallel'
                ? [
                    'branch-01',
                    'branch-02',
                    'branch-03',
                    'branch-04',
                    'branch-05',
                    'branch-06',
                    'branch-07',
                    'branch-08',
                    'branch-09',
                    'branch-10',
                    'branch-11',
                    'branch-12',
                    'branch-13',
                    'branch-14',
                    'branch-15',
                    'branch-16',
                  ]
                : ['out'],
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
  readonly manualRetryClass?: NodeManifest['retryClass'];
  readonly setRetryClass?: NodeManifest['retryClass'];
  readonly condition?: boolean;
  readonly switch?: boolean;
  readonly parallel?: boolean;
  readonly merge?: boolean;
}): RegistryRelease {
  const definitions = [
    manifest('core.manual'),
    manifest(
      'core.set',
      input?.mutateSet ? [jsonataPolicy] : [boundedPolicy, jsonataPolicy],
    ),
    manifest('core.terminate'),
    ...(input?.condition ? [manifest('core.condition')] : []),
    ...(input?.switch ? [manifest('core.switch')] : []),
    ...(input?.parallel ? [manifest('core.parallel')] : []),
    ...(input?.merge ? [manifest('core.merge')] : []),
    ...(input?.unrelated ? [manifest('test.unrelated')] : []),
  ];
  const manual = definitions.find(
    ({ definition }) => definition.key === 'core.manual',
  );
  const set = definitions.find(
    ({ definition }) => definition.key === 'core.set',
  );
  if (manual !== undefined && input?.manualRetryClass !== undefined)
    Object.assign(manual, { retryClass: input.manualRetryClass });
  if (set !== undefined && input?.setRetryClass !== undefined)
    Object.assign(set, { retryClass: input.setRetryClass });
  if (input?.driftCapability) {
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

function conditionGraph(sourcePort: string) {
  const base = graph();
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...base.nodes[1],
        id: 'condition',
        definition: { key: 'core.condition', version: 1 },
        inputMappings: {
          condition: { kind: 'literal' as const, value: true },
        },
      },
      base.nodes[2],
    ],
    edges: [
      {
        id: 'manual-condition',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'condition', port: 'in' },
      },
      {
        id: 'condition-terminate',
        source: { nodeId: 'condition', port: sourcePort },
        target: { nodeId: 'terminate', port: 'in' },
      },
    ],
  };
}

function switchGraph(sourcePort: string) {
  const base = graph();
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...base.nodes[1],
        id: 'switch',
        definition: { key: 'core.switch', version: 1 },
        config: {
          cases: [
            { id: 'case-02', equals: 'selected' },
            { id: 'case-01', equals: 'other' },
          ],
        },
        inputMappings: {
          value: { kind: 'literal' as const, value: 'selected' },
        },
      },
      base.nodes[2],
    ],
    edges: [
      {
        id: 'manual-switch',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'switch', port: 'in' },
      },
      {
        id: 'switch-terminate',
        source: { nodeId: 'switch', port: sourcePort },
        target: { nodeId: 'terminate', port: 'in' },
      },
    ],
  };
}

function parallelGraph(secondPort = 'branch-02') {
  const base = graph();
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...base.nodes[1],
        id: 'parallel',
        definition: { key: 'core.parallel', version: 1 },
        config: {
          branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
          maxConcurrency: 1,
        },
        inputMappings: {},
      },
      { ...base.nodes[1], id: 'left' },
      { ...base.nodes[2], id: 'right' },
    ],
    edges: [
      {
        id: 'manual-parallel',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'parallel', port: 'in' },
      },
      {
        id: 'parallel-left',
        source: { nodeId: 'parallel', port: 'branch-01' },
        target: { nodeId: 'left', port: 'in' },
      },
      {
        id: 'parallel-right',
        source: { nodeId: 'parallel', port: secondPort },
        target: { nodeId: 'right', port: 'in' },
      },
    ],
  };
}

function pairedParallelGraph() {
  const base = graph();
  return {
    ...base,
    nodes: [
      base.nodes[0],
      {
        ...base.nodes[1],
        id: 'parallel',
        definition: { key: 'core.parallel', version: 1 },
        config: {
          branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
          maxConcurrency: 1,
        },
        inputMappings: {},
      },
      { ...base.nodes[1], id: 'left' },
      { ...base.nodes[1], id: 'right' },
      {
        ...base.nodes[1],
        id: 'merge',
        definition: { key: 'core.merge', version: 1 },
        config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
        inputMappings: {},
      },
      base.nodes[2],
    ],
    edges: [
      {
        id: 'manual-parallel',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'parallel', port: 'in' },
      },
      {
        id: 'parallel-left',
        source: { nodeId: 'parallel', port: 'branch-01' },
        target: { nodeId: 'left', port: 'in' },
      },
      {
        id: 'parallel-right',
        source: { nodeId: 'parallel', port: 'branch-02' },
        target: { nodeId: 'right', port: 'in' },
      },
      {
        id: 'left-merge',
        source: { nodeId: 'left', port: 'out' },
        target: { nodeId: 'merge', port: 'branch-01' },
      },
      {
        id: 'right-merge',
        source: { nodeId: 'right', port: 'out' },
        target: { nodeId: 'merge', port: 'branch-02' },
      },
      {
        id: 'merge-terminate',
        source: { nodeId: 'merge', port: 'out' },
        target: { nodeId: 'terminate', port: 'in' },
      },
    ],
  };
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
      nodeRelease({ epoch: 2 }),
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
        composeExecutableCompatibilityRelease(nodeRelease({ epoch: 3 })),
      ]),
    ).toThrow('successor');
    expect(() =>
      createExecutableCompatibilityReleaseSupport([
        current,
        target,
        composeExecutableCompatibilityRelease(nodeRelease({ epoch: 3 })),
      ]),
    ).toThrow('one rolling overlap');
  });

  it('keeps retained executable history separate from the rolling readiness overlap', () => {
    const releases = [1, 2, 3].map((epoch) =>
      composeExecutableCompatibilityRelease(nodeRelease({ epoch })),
    );
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
    } as const;
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

describe('Phase 3 production operations', () => {
  it('keeps the generic scheduler graph seam on the server-only testing entry', () => {
    expect(productionEngine).not.toHaveProperty('deriveReadyNodes');
    expect(productionEngine).not.toHaveProperty('parseSchedulerGraph');
    expect(testingEngine).toHaveProperty('deriveReadyNodes');
    expect(testingEngine.advanceWorkflow).not.toBe(
      productionEngine.advanceWorkflow,
    );
  });

  it('advances only through the verified V2 graph and rejects malformed observations', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const checkpoint = createCheckpoint({
      engineVersion: 'engine-v1',
      workflowVersionId: 'version-1',
      iterationBudget: 0,
    });
    const first = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint,
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    expect(first.attempts.map(({ nodeId }) => nodeId)).toEqual(['manual']);
    const foreignCheckpoint = structuredClone(first.checkpoint);
    Object.assign(foreignCheckpoint.invocations[0] ?? {}, { nodeId: 'set' });
    await expect(
      advanceWorkflow({
        runId: 'run-1',
        executable,
        workflowVersionId: 'version-1',
        checkpoint: foreignCheckpoint,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
    expect(
      await advanceWorkflow({
        runId: 'run-1',
        executable,
        workflowVersionId: 'version-1',
        checkpoint,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [],
        signal: new AbortController().signal,
      }),
    ).toEqual(first);
    await expect(
      advanceWorkflow({
        runId: 'run-1',
        executable,
        workflowVersionId: 'version-1',
        checkpoint,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [{ kind: 'loop_started' }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    await expect(
      advanceWorkflow({
        runId: 'run-1',
        executable,
        workflowVersionId: 'version-2',
        checkpoint,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
    await expect(
      advanceWorkflow({
        runId: 'run-1',
        executable: {
          envelope: executable.envelope,
          checksum: executable.checksum,
        },
        workflowVersionId: 'version-1',
        checkpoint,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'executable_invalid' });
  });

  it('accepts canonical branch-scoped checkpoint V2 identity', async () => {
    const workflowVersionId = 'version-condition';
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ condition: true }),
    );
    const executable = buildWorkflowExecutableV2({
      graph: conditionGraph('true'),
      release,
    });
    const conditionKey = invocationKey({
      workflowVersionId,
      nodeId: 'condition',
    });
    const terminateKey = invocationKey({
      workflowVersionId,
      nodeId: 'terminate',
      branchPath: ['condition:true'],
    });
    const checkpoint = {
      ...createCheckpointV2({
        engineVersion: 'engine-v2',
        workflowVersionId,
        iterationBudget: 0,
      }),
      revision: 1,
      runStatus: 'running',
      readySet: [terminateKey],
      admittedInvocationKeys: [conditionKey],
      invocations: [
        {
          invocationKey: conditionKey,
          nodeId: 'condition',
          status: 'succeeded',
          attemptNumber: 1,
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000101',
          },
        },
        {
          invocationKey: terminateKey,
          nodeId: 'terminate',
          status: 'ready',
          attemptNumber: 0,
          branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
        },
      ],
      branchSelections: [
        {
          invocationKey: conditionKey,
          nodeId: 'condition',
          selectedOutputPort: 'true',
        },
      ],
    } as const;

    await expect(
      advanceWorkflow({
        runId: 'run-condition',
        executable,
        workflowVersionId,
        checkpoint,
        occurredAt: '2026-08-24T00:00:00.000Z',
        maximumAdmissions: 0,
        observations: [],
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ checkpoint: { schemaVersion: 2 } });
  });

  it('derives a Condition selection only from its persisted inline output', async () => {
    const workflowVersionId = 'version-condition';
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ condition: true }),
    );
    const condition = conditionGraph('true');
    const executable = buildWorkflowExecutableV2({
      graph: {
        ...condition,
        nodes: [
          ...condition.nodes,
          { ...condition.nodes[2], id: 'false-terminate' },
        ],
        edges: [
          ...condition.edges,
          {
            id: 'condition-false-terminate',
            source: { nodeId: 'condition', port: 'false' },
            target: { nodeId: 'false-terminate', port: 'in' },
          },
        ],
      },
      release,
    });
    const manualKey = invocationKey({ workflowVersionId, nodeId: 'manual' });
    const conditionKey = invocationKey({
      workflowVersionId,
      nodeId: 'condition',
    });
    const attemptId = '00000000-0000-4000-8000-000000000102';
    const checkpoint = {
      ...createCheckpointV2({
        engineVersion: 'engine-v2',
        workflowVersionId,
        iterationBudget: 0,
      }),
      runStatus: 'running',
      admittedInvocationKeys: [conditionKey, manualKey],
      invocations: [
        {
          invocationKey: manualKey,
          nodeId: 'manual',
          status: 'succeeded',
          attemptNumber: 1,
        },
        {
          invocationKey: conditionKey,
          nodeId: 'condition',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    } as const;

    const plan = await advanceWorkflow({
      runId: 'run-condition',
      executable,
      workflowVersionId,
      checkpoint,
      observations: [
        {
          sequence: 2,
          occurredAt: '2026-08-24T00:00:00.000Z',
          attemptId,
          attemptNumber: 1,
          kind: 'outcome',
          invocationKey: conditionKey,
          status: 'succeeded',
          output: { kind: 'inline', attemptId },
        },
      ],
      completedOutputs: [
        {
          sequence: 2,
          attemptId,
          invocationKey: conditionKey,
          value: { selectedPort: 'true' },
        },
      ],
      occurredAt: '2026-08-24T00:00:01.000Z',
      maximumAdmissions: 1,
      signal: new AbortController().signal,
    });

    expect(plan.checkpoint).toMatchObject({
      schemaVersion: 2,
      branchSelections: [
        {
          invocationKey: conditionKey,
          nodeId: 'condition',
          selectedOutputPort: 'true',
        },
      ],
    });
    expect(plan.checkpoint.invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'terminate', status: 'running' }),
        expect.objectContaining({
          nodeId: 'false-terminate',
          status: 'skipped',
        }),
      ]),
    );
    expect(plan.attempts.map(({ nodeId }) => nodeId)).toEqual(['terminate']);
  });

  it('derives a Switch selection only from its persisted inline output', async () => {
    const workflowVersionId = 'version-switch';
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ switch: true }),
    );
    const selected = switchGraph('case-02');
    const executable = buildWorkflowExecutableV2({
      graph: {
        ...selected,
        nodes: [
          ...selected.nodes,
          { ...selected.nodes[2], id: 'case-01-terminate' },
          { ...selected.nodes[2], id: 'default-terminate' },
        ],
        edges: [
          ...selected.edges,
          {
            id: 'switch-case-01-terminate',
            source: { nodeId: 'switch', port: 'case-01' },
            target: { nodeId: 'case-01-terminate', port: 'in' },
          },
          {
            id: 'switch-default-terminate',
            source: { nodeId: 'switch', port: 'default' },
            target: { nodeId: 'default-terminate', port: 'in' },
          },
        ],
      },
      release,
    });
    const manualKey = invocationKey({ workflowVersionId, nodeId: 'manual' });
    const switchKey = invocationKey({ workflowVersionId, nodeId: 'switch' });
    const attemptId = '00000000-0000-4000-8000-000000000103';
    const checkpoint = {
      ...createCheckpointV2({
        engineVersion: 'engine-v2',
        workflowVersionId,
        iterationBudget: 0,
      }),
      runStatus: 'running',
      admittedInvocationKeys: [manualKey, switchKey],
      invocations: [
        {
          invocationKey: manualKey,
          nodeId: 'manual',
          status: 'succeeded',
          attemptNumber: 1,
        },
        {
          invocationKey: switchKey,
          nodeId: 'switch',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    } as const;

    const plan = await advanceWorkflow({
      runId: 'run-switch',
      executable,
      workflowVersionId,
      checkpoint,
      observations: [
        {
          sequence: 2,
          occurredAt: '2026-08-24T00:00:00.000Z',
          attemptId,
          attemptNumber: 1,
          kind: 'outcome',
          invocationKey: switchKey,
          status: 'succeeded',
          output: { kind: 'inline', attemptId },
        },
      ],
      completedOutputs: [
        {
          sequence: 2,
          attemptId,
          invocationKey: switchKey,
          value: { selectedPort: 'case-02' },
        },
      ],
      occurredAt: '2026-08-24T00:00:01.000Z',
      maximumAdmissions: 1,
      signal: new AbortController().signal,
    });

    expect(plan.checkpoint).toMatchObject({
      schemaVersion: 2,
      branchSelections: [
        {
          invocationKey: switchKey,
          nodeId: 'switch',
          selectedOutputPort: 'case-02',
        },
      ],
    });
    expect(plan.checkpoint.invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'terminate', status: 'running' }),
        expect.objectContaining({
          nodeId: 'case-01-terminate',
          status: 'skipped',
        }),
        expect.objectContaining({
          nodeId: 'default-terminate',
          status: 'skipped',
        }),
      ]),
    );
    expect(plan.attempts.map(({ nodeId }) => nodeId)).toEqual(['terminate']);
  });

  it('fans out Parallel only from its exact persisted declaration output', async () => {
    const workflowVersionId = 'version-parallel';
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ parallel: true, merge: true }),
    );
    const executable = buildWorkflowExecutableV2({
      graph: pairedParallelGraph(),
      release,
    });
    const manualKey = invocationKey({ workflowVersionId, nodeId: 'manual' });
    const parallelKey = invocationKey({
      workflowVersionId,
      nodeId: 'parallel',
    });
    const attemptId = '00000000-0000-4000-8000-000000000106';
    const checkpoint = {
      ...createCheckpointV2({
        engineVersion: 'engine-v2',
        workflowVersionId,
        iterationBudget: 0,
      }),
      runStatus: 'running',
      admittedInvocationKeys: [manualKey, parallelKey],
      invocations: [
        {
          invocationKey: manualKey,
          nodeId: 'manual',
          status: 'succeeded',
          attemptNumber: 1,
        },
        {
          invocationKey: parallelKey,
          nodeId: 'parallel',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    } as const;
    const observations = [
      {
        sequence: 2,
        occurredAt: '2026-08-24T00:00:00.000Z',
        attemptId,
        attemptNumber: 1,
        kind: 'outcome' as const,
        invocationKey: parallelKey,
        status: 'succeeded' as const,
        output: { kind: 'inline' as const, attemptId },
      },
    ];
    const completedOutput = {
      sequence: 2,
      attemptId,
      invocationKey: parallelKey,
      value: { branchIds: ['branch-02', 'branch-01'] },
    };

    const plan = await advanceWorkflow({
      runId: 'run-parallel',
      executable,
      workflowVersionId,
      checkpoint,
      observations,
      completedOutputs: [completedOutput],
      occurredAt: '2026-08-24T00:00:01.000Z',
      maximumAdmissions: 10,
      signal: new AbortController().signal,
    });
    expect(plan.attempts).toHaveLength(1);
    expect(plan.checkpoint.joins).toEqual([
      {
        joinId: 'merge',
        policy: { kind: 'all' },
        ledger: [
          { branchId: 'branch-01', disposition: 'pending' },
          { branchId: 'branch-02', disposition: 'pending' },
        ],
      },
    ]);
    expect(plan.checkpoint.invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'left', status: 'running' }),
        expect.objectContaining({ nodeId: 'right', status: 'ready' }),
      ]),
    );
    const left = plan.checkpoint.invocations.find(
      ({ nodeId }) => nodeId === 'left',
    );
    if (left === undefined) throw new Error('left branch invocation missing');
    const leftAttemptId = '00000000-0000-4000-8000-000000000107';
    const afterLeft = await advanceWorkflow({
      runId: 'run-parallel',
      executable,
      workflowVersionId,
      checkpoint: plan.checkpoint,
      observations: [
        {
          sequence: plan.checkpoint.nextEventSequence,
          occurredAt: '2026-08-24T00:00:02.000Z',
          attemptId: leftAttemptId,
          attemptNumber: 1,
          kind: 'outcome',
          invocationKey: left.invocationKey,
          status: 'succeeded',
          output: { kind: 'inline', attemptId: leftAttemptId },
        },
      ],
      occurredAt: '2026-08-24T00:00:03.000Z',
      maximumAdmissions: 10,
      signal: new AbortController().signal,
    });
    expect(afterLeft.checkpoint.joins[0]?.ledger).toEqual([
      {
        branchId: 'branch-01',
        disposition: 'arrived',
        output: { kind: 'inline', attemptId: leftAttemptId },
      },
      { branchId: 'branch-02', disposition: 'pending' },
    ]);
    expect(afterLeft.attempts.map(({ nodeId }) => nodeId)).toEqual(['right']);
    const right = afterLeft.checkpoint.invocations.find(
      ({ nodeId }) => nodeId === 'right',
    );
    if (right === undefined) throw new Error('right branch invocation missing');
    const rightAttemptId = '00000000-0000-4000-8000-000000000108';
    const settled = await advanceWorkflow({
      runId: 'run-parallel',
      executable,
      workflowVersionId,
      checkpoint: afterLeft.checkpoint,
      observations: [
        {
          sequence: afterLeft.checkpoint.nextEventSequence,
          occurredAt: '2026-08-24T00:00:04.000Z',
          attemptId: rightAttemptId,
          attemptNumber: 1,
          kind: 'outcome',
          invocationKey: right.invocationKey,
          status: 'succeeded',
          output: { kind: 'inline', attemptId: rightAttemptId },
        },
      ],
      occurredAt: '2026-08-24T00:00:05.000Z',
      maximumAdmissions: 10,
      signal: new AbortController().signal,
    });
    expect(settled.checkpoint.joins[0]).toMatchObject({
      selectedBranchIds: ['branch-01', 'branch-02'],
    });
    expect(settled.attempts.map(({ nodeId }) => nodeId)).toEqual(['merge']);
    const mergeAttempt = settled.attempts[0];
    if (mergeAttempt === undefined) throw new Error('Merge attempt missing');
    const coordinatorInput = {
      ledger: {
        'branch-01': {
          disposition: 'arrived',
          output: { kind: 'inline', attemptId: leftAttemptId },
        },
        'branch-02': {
          disposition: 'arrived',
          output: { kind: 'inline', attemptId: rightAttemptId },
        },
      },
      selectedBranchIds: ['branch-01', 'branch-02'],
    } as const;
    let receivedMergeInput: unknown;
    await expect(
      executeNodeAttempt({
        runId: 'run-parallel',
        nodeRunId: 'node-run-merge',
        attemptId: 'attempt-merge',
        executable,
        workflowVersionId,
        invocationKey: mergeAttempt.invocationKey,
        nodeId: 'merge',
        runInput: {},
        completedNodeOutputs: {},
        coordinatorInput,
        registry: {
          execute: (request) => {
            receivedMergeInput = request.input;
            return Promise.resolve({
              kind: 'succeeded',
              output: coordinatorInput,
            });
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'succeeded', output: coordinatorInput });
    expect(receivedMergeInput).toEqual(coordinatorInput);
    await expect(
      advanceWorkflow({
        runId: 'run-parallel',
        executable,
        workflowVersionId,
        checkpoint,
        observations,
        completedOutputs: [
          { ...completedOutput, value: { branchIds: ['branch-01'] } },
        ],
        occurredAt: '2026-08-24T00:00:01.000Z',
        maximumAdmissions: 10,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it('carries exact pinned side-effect classes into attempt admissions', async () => {
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({
        manualRetryClass: 'unsafe',
        setRetryClass: 'idempotent-with-key',
      }),
    );
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const checkpoint = createCheckpoint({
      engineVersion: 'engine-v1',
      workflowVersionId: 'version-1',
      iterationBudget: 0,
    });
    const manual = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint,
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const manualAttempt = manual.attempts[0];
    if (manualAttempt === undefined) throw new Error('manual was not admitted');
    expect(manualAttempt).toMatchObject({
      nodeId: 'manual',
      sideEffectClass: 'unsafe',
    });
    const completedManual = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: manual.checkpoint,
      occurredAt: '2026-08-20T10:01:00.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          sequence: manual.checkpoint.nextEventSequence,
          occurredAt: '2026-08-20T10:01:00.000Z',
          attemptId: '00000000-0000-4000-8000-000000000011',
          attemptNumber: manualAttempt.attemptNumber,
          kind: 'outcome',
          invocationKey: manualAttempt.invocationKey,
          status: 'succeeded',
        },
      ],
      signal: new AbortController().signal,
    });
    const setAttempt = completedManual.attempts[0];
    if (setAttempt === undefined) throw new Error('set was not admitted');
    const expectedProviderKey = providerIdempotencyKey({
      invocationKey: setAttempt.invocationKey,
      namespace: 'pertexo.node-attempt',
      operationIdentity: 'core.set@1',
      runId: 'run-1',
    });
    expect(setAttempt).toMatchObject({
      nodeId: 'set',
      providerIdempotencyKey: expectedProviderKey,
      sideEffectClass: 'idempotent_with_key',
    });
    expect(
      completedManual.nodeRunAdmissions.find(({ nodeId }) => nodeId === 'set'),
    ).toMatchObject({ providerIdempotencyKey: expectedProviderKey });
  });

  it('assigns the same provider key before capacity admission', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: graph(),
      release: composeExecutableCompatibilityRelease(
        nodeRelease({ manualRetryClass: 'idempotent-with-key' }),
      ),
    });
    const input = {
      runId: 'capacity-run',
      executable,
      workflowVersionId: 'version-1',
      occurredAt: '2026-08-20T10:00:00.000Z',
      observations: [],
      signal: new AbortController().signal,
    } as const;
    const materialized = await advanceWorkflow({
      ...input,
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      maximumAdmissions: 0,
    });
    const admitted = await advanceWorkflow({
      ...input,
      checkpoint: materialized.checkpoint,
      maximumAdmissions: 1,
    });
    expect(materialized.nodeRunAdmissions[0]?.providerIdempotencyKey).toBe(
      admitted.attempts[0]?.providerIdempotencyKey,
    );
  });

  it('resolves typed attempt failure into one coordinator retry transition', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: graph(),
      release: composeExecutableCompatibilityRelease(nodeRelease()),
    });
    const started = await advanceWorkflow({
      runId: 'retry-run',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const attempt = started.attempts[0];
    if (attempt === undefined) throw new Error('attempt was not admitted');

    const retried = await advanceWorkflow({
      runId: 'retry-run',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:01:00.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'attempt_failure',
          occurredAt: '2026-08-20T10:00:30.000Z',
          invocationKey: attempt.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000099',
          attemptNumber: attempt.attemptNumber,
          failureKind: 'retry',
          errorKind: 'rate_limit',
          possiblyDispatched: false,
          safeErrorCode: 'execution.rate_limit',
        },
      ],
      signal: new AbortController().signal,
    });

    const scheduled = retried.events.find(
      ({ name }) => name === 'node.retry_scheduled',
    );
    expect(scheduled?.dueAt).toBe('2026-08-20T10:00:30.897Z');
    expect(retried.attempts).toEqual([]);
    expect(retried.checkpoint.invocations[0]).toMatchObject({
      status: 'waiting',
      resumeAt: scheduled?.dueAt,
      attemptNumber: 1,
    });
  });

  it('preserves a definite executor cancellation as canceled', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: graph(),
      release: composeExecutableCompatibilityRelease(nodeRelease()),
    });
    const started = await advanceWorkflow({
      runId: 'canceled-attempt-run',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const attempt = started.attempts[0];
    if (attempt === undefined) throw new Error('attempt was not admitted');

    const canceled = await advanceWorkflow({
      runId: 'canceled-attempt-run',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:01:00.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'attempt_failure',
          occurredAt: '2026-08-20T10:00:30.000Z',
          invocationKey: attempt.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000098',
          attemptNumber: attempt.attemptNumber,
          failureKind: 'canceled',
          errorKind: 'canceled',
          possiblyDispatched: false,
          safeErrorCode: 'execution.canceled',
        },
      ],
      signal: new AbortController().signal,
    });

    expect(canceled.events.map(({ name }) => name)).toContain('node.canceled');
    expect(canceled.checkpoint.invocations[0]).toMatchObject({
      status: 'canceled',
    });
  });

  it('rejects an untyped attempt failure observation', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: graph(),
      release: composeExecutableCompatibilityRelease(nodeRelease()),
    });
    await expect(
      advanceWorkflow({
        runId: 'invalid-retry-run',
        executable,
        workflowVersionId: 'version-1',
        checkpoint: createCheckpoint({
          engineVersion: 'engine-v1',
          workflowVersionId: 'version-1',
          iterationBudget: 0,
        }),
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [{ kind: 'attempt_failure' }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it('consumes contiguous persisted facts without re-emitting their semantic events', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const checkpoint = createCheckpoint({
      engineVersion: 'engine-v1',
      workflowVersionId: 'version-1',
      iterationBudget: 0,
    });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint,
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const manual = started.attempts[0];
    if (manual === undefined) throw new Error('manual was not admitted');

    const advanced = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 0,
      observations: [
        {
          sequence: started.checkpoint.nextEventSequence,
          occurredAt: '2026-08-20T10:01:00.000Z',
          attemptId: '00000000-0000-4000-8000-000000000012',
          attemptNumber: manual.attemptNumber,
          kind: 'outcome',
          invocationKey: manual.invocationKey,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000012',
          },
        },
      ],
      signal: new AbortController().signal,
    });

    expect(advanced.expectedNextEventSequence).toBe(
      started.checkpoint.nextEventSequence,
    );
    expect(advanced.consumedThroughEventSequence).toBe(
      started.checkpoint.nextEventSequence,
    );
    expect(advanced.events).toEqual([
      expect.objectContaining({ name: 'node.ready', sequence: 5 }),
    ]);
    expect(advanced.events).not.toContainEqual(
      expect.objectContaining({ name: 'node.succeeded' }),
    );
    expect(advanced.checkpoint.nextEventSequence).toBe(
      started.checkpoint.nextEventSequence + 2,
    );
  });

  it('rejects cursor gaps, reorder, conflicts, and stale attempt outcomes', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const manual = started.attempts[0];
    if (manual === undefined) throw new Error('manual was not admitted');
    const expected = started.checkpoint.nextEventSequence;
    const outcome = {
      sequence: expected,
      occurredAt: '2026-08-20T10:01:00.000Z',
      attemptId: '00000000-0000-4000-8000-000000000021',
      attemptNumber: manual.attemptNumber,
      kind: 'outcome',
      invocationKey: manual.invocationKey,
      status: 'succeeded',
    } as const;
    const input = {
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 0,
      signal: new AbortController().signal,
    } as const;

    await expect(
      advanceWorkflow({
        ...input,
        observations: [{ ...outcome, sequence: expected + 1 }],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    await expect(
      advanceWorkflow({
        ...input,
        observations: [
          {
            kind: 'cancel_requested',
            sequence: expected + 1,
            occurredAt: outcome.occurredAt,
          },
          outcome,
        ],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    await expect(
      advanceWorkflow({
        ...input,
        observations: [outcome, { ...outcome, status: 'failed' }],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    await expect(
      advanceWorkflow({
        ...input,
        observations: [{ ...outcome, attemptNumber: manual.attemptNumber + 1 }],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    await expect(
      advanceWorkflow({
        ...input,
        observations: [{ ...outcome, status: 'skipped' }],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });

    const consumed = await advanceWorkflow({
      ...input,
      observations: [outcome, outcome],
    });
    expect(consumed.consumedThroughEventSequence).toBe(expected);
    const staleDuplicate = await advanceWorkflow({
      ...input,
      checkpoint: consumed.checkpoint,
      observations: [outcome],
    });
    expect(staleDuplicate.consumedThroughEventSequence).toBe(
      consumed.checkpoint.nextEventSequence - 1,
    );
    await expect(
      advanceWorkflow({
        ...input,
        checkpoint: consumed.checkpoint,
        observations: [{ ...outcome, status: 'failed' }],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it('starts derived events strictly after the consumed external high-water', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const sourceGraph = graph();
    const manualNode = sourceGraph.nodes[0];
    const singleNode = { ...sourceGraph, nodes: [manualNode], edges: [] };
    const executable = buildWorkflowExecutableV2({
      graph: singleNode,
      release,
    });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const manual = started.attempts[0];
    if (manual === undefined) throw new Error('manual was not admitted');
    const externalSequence = started.checkpoint.nextEventSequence;
    const completed = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 0,
      observations: [
        {
          kind: 'cursor_only',
          eventName: 'node.started',
          sequence: externalSequence,
          occurredAt: '2026-08-20T10:00:30.000Z',
          invocationKey: manual.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000042',
          attemptNumber: manual.attemptNumber,
        },
        {
          sequence: externalSequence + 1,
          occurredAt: '2026-08-20T10:01:00.000Z',
          attemptId: '00000000-0000-4000-8000-000000000022',
          attemptNumber: manual.attemptNumber,
          kind: 'outcome',
          invocationKey: manual.invocationKey,
          status: 'succeeded',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(
      completed.events.map(({ name, sequence }) => [name, sequence]),
    ).toEqual([['run.succeeded', externalSequence + 2]]);
    expect(completed.consumedThroughEventSequence).toBe(externalSequence + 1);
    expect(completed.checkpoint.nextEventSequence).toBe(externalSequence + 3);
    expect(completed.events).not.toContainEqual(
      expect.objectContaining({ name: 'node.started' }),
    );
  });

  it('consumes persisted waits with attempt fencing and resumes due work as engine-owned readiness', async () => {
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ manualRetryClass: 'idempotent-with-key' }),
    );
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const manual = started.attempts[0];
    if (manual === undefined) throw new Error('manual was not admitted');
    const wait = {
      kind: 'wait',
      eventName: 'node.retry_scheduled',
      sequence: started.checkpoint.nextEventSequence,
      occurredAt: '2026-08-20T10:01:00.000Z',
      invocationKey: manual.invocationKey,
      attemptId: '00000000-0000-4000-8000-000000000041',
      attemptNumber: manual.attemptNumber,
      resumeAt: '2026-08-20T10:05:00.000Z',
    } as const;
    const input = {
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 1,
      signal: new AbortController().signal,
    } as const;
    await expect(
      advanceWorkflow({
        ...input,
        observations: [{ ...wait, attemptNumber: manual.attemptNumber + 1 }],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });

    const waiting = await advanceWorkflow({ ...input, observations: [wait] });
    expect(waiting.checkpoint.invocations[0]).toMatchObject({
      status: 'waiting',
      resumeAt: wait.resumeAt,
    });
    expect(waiting.events).not.toContainEqual(
      expect.objectContaining({ name: 'node.waiting' }),
    );

    const due = {
      kind: 'due_at',
      occurredAt: wait.resumeAt,
      invocationKey: manual.invocationKey,
    } as const;
    await expect(
      advanceWorkflow({
        ...input,
        checkpoint: waiting.checkpoint,
        observations: [{ ...due, occurredAt: '2026-08-20T10:04:59.999Z' }],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    const pending = {
      ...waiting.checkpoint,
      invocations: waiting.checkpoint.invocations.map((invocation) => {
        const { resumeAt: _, ...withoutResumeAt } = invocation;
        void _;
        return invocation.invocationKey === manual.invocationKey
          ? { ...withoutResumeAt, status: 'pending' as const }
          : invocation;
      }),
    };
    await expect(
      advanceWorkflow({ ...input, checkpoint: pending, observations: [due] }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    const terminal = {
      ...waiting.checkpoint,
      invocations: waiting.checkpoint.invocations.map((invocation) => {
        const { resumeAt: _, ...withoutResumeAt } = invocation;
        void _;
        return invocation.invocationKey === manual.invocationKey
          ? { ...withoutResumeAt, status: 'succeeded' as const }
          : invocation;
      }),
    };
    await expect(
      advanceWorkflow({ ...input, checkpoint: terminal, observations: [due] }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    const resumed = await advanceWorkflow({
      ...input,
      checkpoint: waiting.checkpoint,
      observations: [due],
    });
    expect(resumed.consumedThroughEventSequence).toBe(
      waiting.checkpoint.nextEventSequence - 1,
    );
    expect(resumed.events).toContainEqual(
      expect.objectContaining({
        name: 'node.ready',
        occurredAt: due.occurredAt,
      }),
    );
    expect(resumed.nodeRunAdmissions).toEqual([]);
    expect(resumed.attempts).toEqual([
      expect.objectContaining({
        invocationKey: manual.invocationKey,
        attemptNumber: manual.attemptNumber + 1,
        providerIdempotencyKey: manual.providerIdempotencyKey,
      }),
    ]);
    const duplicate = await advanceWorkflow({
      ...input,
      checkpoint: resumed.checkpoint,
      observations: [due],
    });
    expect(duplicate.events).toEqual([]);
    expect(duplicate.attempts).toEqual([]);
  });

  it('orders simultaneous due resumptions independently of loader row order', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const sourceGraph = graph();
    const executable = buildWorkflowExecutableV2({
      graph: { ...sourceGraph, edges: [] },
      release,
    });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 2,
      observations: [],
      signal: new AbortController().signal,
    });
    const waiting = structuredClone(started.checkpoint);
    for (const invocation of waiting.invocations.filter(
      ({ status }) => status === 'running',
    ))
      Object.assign(invocation, {
        status: 'waiting',
        resumeAt: '2026-08-20T10:05:00.000Z',
      });
    const dues = waiting.invocations
      .filter(({ status }) => status === 'waiting')
      .map(({ invocationKey }) => ({
        kind: 'due_at' as const,
        occurredAt: '2026-08-20T10:05:00.000Z',
        invocationKey,
      }));
    expect(dues).toHaveLength(2);
    const input = {
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: waiting,
      occurredAt: '2026-08-20T10:05:00.000Z',
      maximumAdmissions: 2,
      signal: new AbortController().signal,
    } as const;
    const forward = await advanceWorkflow({ ...input, observations: dues });
    const reverse = await advanceWorkflow({
      ...input,
      observations: [...dues].reverse(),
    });
    expect(reverse).toEqual(forward);
    expect(
      forward.events.filter(({ name }) => name === 'node.ready'),
    ).toHaveLength(2);
    expect(forward.nodeRunAdmissions).toEqual([]);
    expect(forward.attempts).toHaveLength(2);
  });

  it('applies persisted cancel and deadline controls before materializing work', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const initial = createCheckpoint({
      engineVersion: 'engine-v1',
      workflowVersionId: 'version-1',
      iterationBudget: 0,
    });
    const canceled = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: initial,
      occurredAt: '2026-08-20T10:01:00.000Z',
      maximumAdmissions: 10,
      observations: [
        {
          kind: 'cancel_requested',
          sequence: initial.nextEventSequence,
          occurredAt: '2026-08-20T10:00:00.000Z',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(canceled.nodeRunAdmissions).toEqual([]);
    expect(canceled.attempts).toEqual([]);
    expect(
      canceled.events.map(({ name, sequence }) => [name, sequence]),
    ).toEqual([['run.canceled', initial.nextEventSequence + 1]]);

    const timedOut = await advanceWorkflow({
      runId: 'run-2',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: initial,
      occurredAt: '2026-08-20T10:01:00.000Z',
      maximumAdmissions: 10,
      observations: [
        {
          kind: 'deadline_expired',
          occurredAt: '2026-08-20T10:00:00.000Z',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(timedOut.expectedNextEventSequence).toBe(initial.nextEventSequence);
    expect(timedOut.consumedThroughEventSequence).toBe(
      initial.nextEventSequence - 1,
    );
    expect(timedOut.checkpoint).toMatchObject({
      cancelRequested: false,
      deadlineExpired: true,
      runStatus: 'timed_out',
    });
    expect(timedOut.nodeRunAdmissions).toEqual([]);
    expect(timedOut.attempts).toEqual([]);
    expect(
      timedOut.events.map(({ name, sequence }) => [name, sequence]),
    ).toEqual([['run.timed_out', initial.nextEventSequence]]);
  });

  it('persists deadline state while active work reconciles before run timeout', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const manual = started.attempts[0];
    if (manual === undefined) throw new Error('manual was not admitted');
    const expired = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 10,
      observations: [
        {
          kind: 'deadline_expired',
          occurredAt: '2026-08-20T10:01:00.000Z',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(expired.checkpoint).toMatchObject({
      deadlineExpired: true,
      runStatus: 'running',
    });
    expect(expired.attempts).toEqual([]);
    expect(expired.nodeRunAdmissions).toEqual([]);

    const externalSequence = expired.checkpoint.nextEventSequence;
    const reconciled = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: expired.checkpoint,
      occurredAt: '2026-08-20T10:03:00.000Z',
      maximumAdmissions: 10,
      observations: [
        {
          sequence: externalSequence,
          occurredAt: '2026-08-20T10:03:00.000Z',
          attemptId: '00000000-0000-4000-8000-000000000023',
          attemptNumber: manual.attemptNumber,
          kind: 'outcome',
          invocationKey: manual.invocationKey,
          status: 'timed_out',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(reconciled.checkpoint.runStatus).toBe('timed_out');
    expect(
      reconciled.events.map(({ name, sequence }) => [name, sequence]),
    ).toEqual([['run.timed_out', externalSequence + 1]]);
  });

  it('settles durable waiting work on deadline or cancellation without reconciliation', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const waiting = structuredClone(started.checkpoint);
    const invocation = waiting.invocations[0];
    if (invocation === undefined) throw new Error('manual was not persisted');
    Object.assign(invocation, {
      status: 'waiting',
      resumeAt: '2026-08-21T10:00:00.000Z',
    });

    const expired = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: waiting,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'deadline_expired',
          occurredAt: '2026-08-20T10:01:00.000Z',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(expired.checkpoint.invocations[0]).toMatchObject({
      status: 'timed_out',
    });
    expect(expired.checkpoint.invocations[0]).not.toHaveProperty('resumeAt');
    expect(expired.checkpoint.runStatus).toBe('timed_out');
    expect(expired.events.map(({ name }) => name)).toEqual([
      'node.timed_out',
      'run.timed_out',
    ]);

    const canceled = await advanceWorkflow({
      runId: 'run-2',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: waiting,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'cancel_requested',
          sequence: waiting.nextEventSequence,
          occurredAt: '2026-08-20T10:01:00.000Z',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(canceled.checkpoint.invocations[0]).toMatchObject({
      status: 'canceled',
    });
    expect(canceled.checkpoint.invocations[0]).not.toHaveProperty('resumeAt');
    expect(canceled.checkpoint.runStatus).toBe('canceled');
    expect(canceled.events.map(({ name }) => name)).toEqual([
      'node.canceled',
      'run.canceled',
    ]);
  });

  it('plans every materialized node run independently of the attempt cap', async () => {
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({
        manualRetryClass: 'unsafe',
        setRetryClass: 'idempotent-with-key',
      }),
    );
    const sourceGraph = graph();
    const parallel = { ...sourceGraph, edges: [] };
    const executable = buildWorkflowExecutableV2({ graph: parallel, release });
    const input = {
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    } as const;
    const first = await advanceWorkflow(input);
    expect(first.nodeRunAdmissions).toEqual([
      expect.objectContaining({ nodeId: 'manual', sideEffectClass: 'unsafe' }),
      expect.objectContaining({
        nodeId: 'set',
        sideEffectClass: 'idempotent_with_key',
      }),
      expect.objectContaining({ nodeId: 'terminate', sideEffectClass: 'safe' }),
    ]);
    expect(first.attempts).toHaveLength(1);
    expect(await advanceWorkflow(input)).toEqual(first);

    const disabledGraph = structuredClone(graph());
    Object.assign(disabledGraph.nodes[0], { disabled: true });
    const disabledExecutable = buildWorkflowExecutableV2({
      graph: disabledGraph,
      release,
    });
    const skipped = await advanceWorkflow({
      ...input,
      executable: disabledExecutable,
    });
    expect(skipped.nodeRunAdmissions).toEqual([
      expect.objectContaining({ nodeId: 'manual', sideEffectClass: 'unsafe' }),
    ]);
    expect(skipped.attempts).toEqual([]);
    expect(skipped.events).toContainEqual(
      expect.objectContaining({ name: 'node.skipped', nodeId: 'manual' }),
    );
  });

  it('requires canonical UUID output locators bound to inline attempt identity', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const manual = started.attempts[0];
    if (manual === undefined) throw new Error('manual was not admitted');
    const base = {
      sequence: started.checkpoint.nextEventSequence,
      occurredAt: '2026-08-20T10:01:00.000Z',
      attemptId: '00000000-0000-4000-8000-000000000031',
      attemptNumber: manual.attemptNumber,
      kind: 'outcome',
      invocationKey: manual.invocationKey,
      status: 'succeeded',
    } as const;
    const input = {
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 0,
      signal: new AbortController().signal,
    } as const;
    for (const output of [
      { kind: 'inline', attemptId: '00000000-0000-4000-8000-000000000032' },
      { kind: 'artifact', artifactId: 'NOT-A-UUID' },
      { kind: 'artifact', artifactId: '00000000-0000-4000-8000-00000000003A' },
    ] as const)
      await expect(
        advanceWorkflow({ ...input, observations: [{ ...base, output }] }),
      ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it('resolves mapped inputs and preserves confirmed success after abort', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const mappedGraph = structuredClone(graph());
    Object.assign(mappedGraph.nodes[1], {
      inputMappings: {
        literal: { kind: 'literal', value: null },
        fromRun: { kind: 'run_input', path: '$.name' },
        fromNode: {
          kind: 'node_output',
          nodeId: 'manual',
          path: '$.base',
        },
        missing: { kind: 'run_input', path: '$.absent' },
        expression: {
          kind: 'expression',
          language: 'jsonata',
          expression: 'runInput.count + nodeOutputs.manual.base',
          policyVersion: 1,
        },
      },
    });
    const executable = buildWorkflowExecutableV2({
      graph: mappedGraph,
      release,
    });
    let received: unknown;
    const registry = {
      execute: (request: { readonly input: unknown }) => {
        received = request.input;
        return Promise.resolve({
          kind: 'succeeded' as const,
          output: request.input as never,
        });
      },
    };
    const outcome = await executeNodeAttempt({
      runId: 'run-1',
      nodeRunId: 'node-run-1',
      attemptId: 'attempt-1',
      executable,
      workflowVersionId: 'version-1',
      invocationKey: invocationKey({
        workflowVersionId: 'version-1',
        nodeId: 'set',
      }),
      nodeId: 'set',
      runInput: { name: 'Ada', count: 2 },
      completedNodeOutputs: { manual: { base: 3 } },
      registry,
      signal: new AbortController().signal,
    });
    expect(received).toEqual({
      expression: 5,
      fromNode: 3,
      fromRun: 'Ada',
      literal: null,
    });
    expect(outcome).toMatchObject({
      runId: 'run-1',
      nodeRunId: 'node-run-1',
      attemptId: 'attempt-1',
      nodeId: 'set',
      kind: 'succeeded',
    });
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-branch',
        attemptId: 'attempt-branch',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
          branchPath: ['condition:true'],
        }),
        nodeId: 'set',
        branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { manual: { base: 3 } },
        registry,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      invocationKey: 'version-1|set|b:condition%3Atrue|i:',
      kind: 'succeeded',
    });
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-1',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: 'node:set',
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { manual: { base: 3 } },
        registry,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-1',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { terminate: {} },
        registry,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });

    const controller = new AbortController();
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-1',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { manual: { base: 3 } },
        registry: {
          execute: (request: { readonly input: unknown }) => {
            controller.abort();
            return Promise.resolve({
              kind: 'succeeded' as const,
              output: request.input as never,
            });
          },
        },
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      attemptId: 'attempt-1',
      kind: 'succeeded',
    });

    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-2',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { manual: { base: 3 } },
        registry: {
          execute: () => Promise.reject(new NodeExecutionAbortedError()),
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_aborted' });

    const { NodeExecutorFailure } = await import('@pertexo/node-sdk/server');
    const unknownOutcome = new NodeExecutorFailure({
      kind: 'outcome_unknown',
      errorKind: 'provider',
      possiblyDispatched: true,
    });
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-unknown',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { manual: { base: 3 } },
        registry: { execute: () => Promise.reject(unknownOutcome) },
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(unknownOutcome);

    const retry = new NodeExecutorFailure({
      kind: 'retry',
      errorKind: 'rate_limit',
      possiblyDispatched: false,
    });
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-retry',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { manual: { base: 3 } },
        registry: { execute: () => Promise.reject(retry) },
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(retry);

    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-3',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { manual: { base: 3 } },
        registry: {
          execute: () =>
            Promise.reject(new DOMException('aborted', 'AbortError')),
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_aborted' });

    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-4',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { name: 'Ada', count: 2 },
        completedNodeOutputs: { manual: { base: 3 } },
        registry: {
          execute: () => Promise.reject(new Error('invalid output')),
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: 'attempt_invalid',
      message: 'node execution failed',
    });
  });

  it('resolves isolated preview inputs through the production mapping path', async () => {
    await expect(
      resolveSingleNodePreviewInput({
        node: {
          config: {},
          configVersion: 1,
          connectionRefs: {},
          definition: { key: 'core.set', version: 1 },
          id: 'preview-node',
          inputMappings: {
            expression: {
              expression: 'runInput.count * 2',
              kind: 'expression',
              language: 'jsonata',
              policyVersion: 1,
            },
            fromRun: { kind: 'run_input', path: '$.name' },
            literal: { kind: 'literal', value: true },
            missing: { kind: 'run_input', path: '$.absent' },
          },
        },
        runInput: { count: 4, name: 'Ada' },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ expression: 8, fromRun: 'Ada', literal: true });

    await expect(
      resolveSingleNodePreviewInput({
        node: {
          config: {},
          configVersion: 1,
          connectionRefs: {},
          definition: { key: 'core.set', version: 1 },
          id: 'preview-node',
          inputMappings: {
            upstream: {
              kind: 'node_output',
              nodeId: 'another-node',
              path: '$.value',
            },
          },
        },
        runInput: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });
  });

  it('classifies aggregate mapped-input overflow as an invalid attempt', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const repeatedGraph = structuredClone(graph());
    Object.assign(repeatedGraph.nodes[1], {
      inputMappings: {
        first: { kind: 'run_input', path: '$.large' },
        second: { kind: 'run_input', path: '$.large' },
      },
    });
    const executable = buildWorkflowExecutableV2({
      graph: repeatedGraph,
      release,
    });
    let executions = 0;
    await expect(
      executeNodeAttempt({
        runId: 'run-1',
        nodeRunId: 'node-run-1',
        attemptId: 'attempt-1',
        executable,
        workflowVersionId: 'version-1',
        invocationKey: invocationKey({
          workflowVersionId: 'version-1',
          nodeId: 'set',
        }),
        nodeId: 'set',
        runInput: { large: 'x'.repeat(600_000) },
        completedNodeOutputs: { manual: {} },
        registry: {
          execute: () => {
            executions += 1;
            return Promise.resolve({ kind: 'succeeded' as const, output: {} });
          },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: 'attempt_invalid',
      message: 'mapped input exceeds runtime limits',
    });
    expect(executions).toBe(0);
  });
});
