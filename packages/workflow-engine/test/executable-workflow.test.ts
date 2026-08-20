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
  createCheckpoint,
  executeNodeAttempt,
  invocationKey,
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
  readonly manualRetryClass?: NodeManifest['retryClass'];
  readonly setRetryClass?: NodeManifest['retryClass'];
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
          kind: 'outcome',
          invocationKey: manualAttempt.invocationKey,
          status: 'succeeded',
        },
      ],
      signal: new AbortController().signal,
    });
    const set = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: completedManual.checkpoint,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    expect(set.attempts[0]).toMatchObject({
      nodeId: 'set',
      sideEffectClass: 'idempotent_with_key',
    });
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
