import { createRegistryRelease } from '@pertexo/node-sdk';
import { WORKFLOW_CALL_FAMILY_POLICY_V1 } from '@pertexo/workflow-model/workflow-call-contract';
import { describe, expect, it, vi } from 'vitest';

import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  parseWorkflowExecutableV2,
} from '../src/executable-workflow.js';
import {
  assertAuthenticExecutableIdentityV3,
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityReleaseV3,
  computeWorkflowExecutableChecksumV3,
  parseWorkflowExecutableV3,
  verifyWorkflowExecutableV3,
  WORKFLOW_CALL_RUNTIME_POLICIES_V1,
  type WorkflowExecutableV3,
} from '../src/compilation/executable-v3.js';
import {
  forEachGraph,
  graph,
  nodeRelease,
  pairedParallelGraph,
} from './executable-workflow.fixtures.js';

const emptyType = { type: 'object', properties: {}, required: [] } as const;
const callable = {
  schemaVersion: 1,
  input: emptyType,
  result: emptyType,
  resultSelector: { kind: 'literal', value: {} },
} as const;
const v3Graph = () => ({ ...graph(), schemaVersion: 2, callable });
const release = () => composeExecutableCompatibilityReleaseV3(nodeRelease());
const invalid: unknown = expect.objectContaining({
  code: 'executable_invalid',
});

describe('workflow executable V3', () => {
  it('compiles and authenticates immutable callable and family policy pins', () => {
    const admissionRelease = release();
    const compiled = buildWorkflowExecutableV3({
      graph: v3Graph(),
      release: admissionRelease,
    });
    expect(compiled.envelope).toMatchObject({
      schemaVersion: 3,
      sourceGraphSchemaVersion: 2,
      familyPolicy: WORKFLOW_CALL_FAMILY_POLICY_V1,
      runtimePolicies: WORKFLOW_CALL_RUNTIME_POLICIES_V1,
      graph: { callable },
    });
    expect(compiled.checksum).toMatch(/^wf:v3:sha256:[0-9a-f]{64}$/u);
    expect(compiled.envelope.compatibilitySelectionFingerprint).toMatch(
      /^engine-select:v3:sha256:[0-9a-f]{64}$/u,
    );
    expect(
      Object.isFrozen(compiled.envelope.graph.callable?.input.properties),
    ).toBe(true);
    expect(() => {
      assertAuthenticExecutableIdentityV3(compiled);
    }).not.toThrow();
    expect(() => {
      assertAuthenticExecutableIdentityV3({ ...compiled });
    }).toThrow(invalid);
    const verified = verifyWorkflowExecutableV3({
      ...compiled,
      admissionRelease,
    });
    expect(verified).toEqual(compiled);
    expect(() => {
      assertAuthenticExecutableIdentityV3(verified);
    }).not.toThrow();
  });

  it('supports V2 authoring without a callable declaration and existing loop structure', () => {
    const withoutCallable = buildWorkflowExecutableV3({
      graph: { ...graph(), schemaVersion: 2 },
      release: release(),
    });
    expect(withoutCallable.envelope.graph).not.toHaveProperty('callable');
    const loops = buildWorkflowExecutableV3({
      graph: { ...forEachGraph(), schemaVersion: 2 },
      release: composeExecutableCompatibilityReleaseV3(
        nodeRelease({ forEach: true }),
      ),
    });
    expect(
      loops.envelope.graph.nodes.some((node) => node.structured !== undefined),
    ).toBe(true);
  });

  it('preserves baseline policies and every V2 executable identity', () => {
    const oldRelease = composeExecutableCompatibilityRelease(nodeRelease());
    const newRelease = release();
    expect(newRelease.policies).toEqual(
      expect.arrayContaining([...oldRelease.policies]),
    );
    expect(
      newRelease.policies.filter(({ key }) => key === 'engine.retry'),
    ).toHaveLength(1);
    expect(
      buildWorkflowExecutableV2({ graph: graph(), release: newRelease })
        .checksum,
    ).toBe(
      buildWorkflowExecutableV2({ graph: graph(), release: oldRelease })
        .checksum,
    );
    const compiled = buildWorkflowExecutableV3({
      graph: v3Graph(),
      release: newRelease,
    });
    expect(() =>
      parseWorkflowExecutableV2({
        envelope: compiled.envelope,
        admissionRelease: newRelease,
      }),
    ).toThrow(invalid);
    expect(() =>
      buildWorkflowExecutableV3({ graph: graph(), release: newRelease }),
    ).toThrow(invalid);
  });

  it('ignores positions and node/edge input ordering but includes callable semantics', () => {
    const first = buildWorkflowExecutableV3({
      graph: v3Graph(),
      release: release(),
    });
    const reordered = { ...graph(true), schemaVersion: 2, callable };
    expect(
      buildWorkflowExecutableV3({ graph: reordered, release: release() })
        .checksum,
    ).toBe(first.checksum);
    const changed = buildWorkflowExecutableV3({
      graph: {
        ...v3Graph(),
        callable: {
          ...callable,
          input: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      },
      release: release(),
    });
    expect(changed.checksum).not.toBe(first.checksum);
    const selector = buildWorkflowExecutableV3({
      graph: {
        ...v3Graph(),
        callable: {
          ...callable,
          resultSelector: { kind: 'literal', value: { changed: true } },
        },
      },
      release: release(),
    });
    expect(selector.checksum).not.toBe(first.checksum);
  });

  it('hashes family and runtime policy pins, not admission release provenance', () => {
    const first = buildWorkflowExecutableV3({
      graph: v3Graph(),
      release: release(),
    });
    const newer = buildWorkflowExecutableV3({
      graph: v3Graph(),
      release: composeExecutableCompatibilityReleaseV3(
        nodeRelease({ epoch: 2, unrelated: true }),
      ),
    });
    expect(newer.checksum).toBe(first.checksum);
    expect(newer.envelope.compatibilityReleaseFingerprint).not.toBe(
      first.envelope.compatibilityReleaseFingerprint,
    );
    const changedRuntime = {
      ...first.envelope,
      runtimePolicies: {
        ...first.envelope.runtimePolicies,
        scheduler: { key: 'engine.scheduler', version: 1 },
      },
    };
    expect(computeWorkflowExecutableChecksumV3(changedRuntime)).not.toBe(
      first.checksum,
    );
    // Deliberately forged wire data; the parser rejects this changed policy.
    const changedFamily = {
      ...first.envelope,
      familyPolicy: { ...first.envelope.familyPolicy, maxChildRuns: 65 },
    } as unknown as WorkflowExecutableV3;
    expect(computeWorkflowExecutableChecksumV3(changedFamily)).not.toBe(
      first.checksum,
    );
    expect(() =>
      parseWorkflowExecutableV3({
        envelope: changedFamily,
        admissionRelease: release(),
      }),
    ).toThrow(invalid);
  });

  it.each([
    ['schemaVersion', 2],
    ['sourceGraphSchemaVersion', 1],
    ['familyPolicy', undefined],
    ['configMigrations', [{ kind: 'unsupported' }]],
    ['compatibilityReleaseEpoch', 99],
    ['compatibilityReleaseFingerprint', 'wrong'],
    ['compatibilitySelectionFingerprint', 'wrong'],
    ['extra', true],
  ])('rejects invalid strict envelope field %s', (field, value) => {
    const admissionRelease = release();
    const compiled = buildWorkflowExecutableV3({
      graph: v3Graph(),
      release: admissionRelease,
    });
    const modified: Record<string, unknown> = {
      ...compiled.envelope,
      [field]: value,
    };
    const envelope = Object.fromEntries(
      Object.entries(modified).filter(
        ([key]) => value !== undefined || key !== field,
      ),
    );
    expect(() =>
      parseWorkflowExecutableV3({ envelope, admissionRelease }),
    ).toThrow(invalid);
  });

  it('rejects tampered checksum, malformed execution context and unsupported selected policy', () => {
    const admissionRelease = release();
    const compiled = buildWorkflowExecutableV3({
      graph: v3Graph(),
      release: admissionRelease,
    });
    expect(() =>
      verifyWorkflowExecutableV3({
        ...compiled,
        checksum: `wf:v3:sha256:${'0'.repeat(64)}`,
        admissionRelease,
      }),
    ).toThrow(invalid);
    expect(() =>
      parseWorkflowExecutableV3({
        envelope: compiled.envelope,
        admissionRelease,
        execution: { alreadyAdmitted: true, extra: true } as {
          alreadyAdmitted: boolean;
        },
      }),
    ).toThrow(invalid);
    const currentRelease = createRegistryRelease({
      epoch: 2,
      definitions: admissionRelease.definitions,
      executors: admissionRelease.executors,
      policies: admissionRelease.policies.filter(
        (policy) =>
          !(policy.key === 'engine.scheduler' && policy.version === 2),
      ),
    });
    expect(() =>
      parseWorkflowExecutableV3({
        envelope: compiled.envelope,
        admissionRelease,
        currentRelease,
      }),
    ).toThrow(invalid);
    expect(() =>
      buildWorkflowExecutableV3({
        graph: v3Graph(),
        release: composeExecutableCompatibilityRelease(nodeRelease()),
      }),
    ).toThrow(invalid);
  });

  it('preserves existing already-admitted retirement eligibility and immutable node behavior', () => {
    const admissionRelease = release();
    const compiled = buildWorkflowExecutableV3({
      graph: v3Graph(),
      release: admissionRelease,
    });
    const currentRelease = composeExecutableCompatibilityReleaseV3(
      nodeRelease({ epoch: 2, executorLifecycle: 'retirement_blocked' }),
    );
    expect(() =>
      verifyWorkflowExecutableV3({
        ...compiled,
        admissionRelease,
        currentRelease,
      }),
    ).toThrow(invalid);
    expect(
      verifyWorkflowExecutableV3({
        ...compiled,
        admissionRelease,
        currentRelease,
        execution: { alreadyAdmitted: true },
      }).checksum,
    ).toBe(compiled.checksum);
    const drifted = composeExecutableCompatibilityReleaseV3(
      nodeRelease({ epoch: 2, driftCapability: true }),
    );
    expect(() =>
      verifyWorkflowExecutableV3({
        ...compiled,
        admissionRelease,
        currentRelease: drifted,
        execution: { alreadyAdmitted: true },
      }),
    ).toThrow(invalid);
  });

  it('selects the callable expression policy even when no node selects it', () => {
    const base = release();
    const admissionRelease = createRegistryRelease({
      epoch: base.epoch,
      definitions: base.definitions.filter(
        ({ definition }) => definition.key === 'core.manual',
      ),
      executors: base.executors.filter(
        ({ executor }) => executor.key === 'core.manual',
      ),
      policies: base.policies,
    });
    const source = { ...v3Graph(), nodes: [graph().nodes[0]], edges: [] };
    const literal = buildWorkflowExecutableV3({
      graph: source,
      release: admissionRelease,
    });
    const expression = buildWorkflowExecutableV3({
      graph: {
        ...source,
        callable: {
          ...callable,
          resultSelector: {
            kind: 'expression',
            language: 'jsonata',
            expression: '{}',
            policyVersion: 1,
          },
        },
      },
      release: admissionRelease,
    });
    expect(expression.envelope.compatibilitySelectionFingerprint).not.toBe(
      literal.envelope.compatibilitySelectionFingerprint,
    );
    const unsupported = createRegistryRelease({
      epoch: 2,
      definitions: admissionRelease.definitions,
      executors: admissionRelease.executors,
      policies: admissionRelease.policies.filter(
        ({ key }) => key !== 'jsonata.restricted',
      ),
    });
    expect(() =>
      verifyWorkflowExecutableV3({
        ...expression,
        admissionRelease,
        currentRelease: unsupported,
      }),
    ).toThrow('missing a callable result policy');
    expect(() =>
      buildWorkflowExecutableV3({
        graph: {
          ...source,
          callable: {
            ...callable,
            resultSelector: {
              kind: 'expression',
              language: 'jsonata',
              expression: '{}',
              policyVersion: 1,
            },
          },
        },
        release: unsupported,
      }),
    ).toThrow('missing a callable result policy');
    expect(
      verifyWorkflowExecutableV3({
        ...literal,
        admissionRelease,
        currentRelease: unsupported,
      }).checksum,
    ).toBe(literal.checksum);
  });

  it.each([
    { kind: 'node_output', nodeId: 'missing', path: '$' },
    { kind: 'node_output', nodeId: 'set', path: '$[' },
    { kind: 'structured_input', port: 'item', path: '$' },
    {
      kind: 'expression',
      language: 'jsonata',
      expression: '$eval("1")',
      policyVersion: 1,
    },
  ])(
    'reuses shared callable selector scope/path/expression validation %#',
    (resultSelector) => {
      expect(() =>
        buildWorkflowExecutableV3({
          graph: { ...v3Graph(), callable: { ...callable, resultSelector } },
          release: release(),
        }),
      ).toThrow(invalid);
    },
  );

  it('retains the topology owner for scoped callable outputs instead of rejecting every branch selector', () => {
    const source = {
      ...pairedParallelGraph(),
      schemaVersion: 2,
      callable: {
        ...callable,
        resultSelector: { kind: 'node_output', nodeId: 'left', path: '$' },
      },
    };
    const admissionRelease = composeExecutableCompatibilityReleaseV3(
      nodeRelease({ parallel: true, merge: true }),
    );
    expect(() =>
      buildWorkflowExecutableV3({ graph: source, release: admissionRelease }),
    ).not.toThrow();
    expect(() =>
      buildWorkflowExecutableV3({
        graph: {
          ...source,
          edges: [
            ...source.edges,
            {
              id: 'left-right',
              source: { nodeId: 'left', port: 'out' },
              target: { nodeId: 'right', port: 'in' },
            },
          ],
        },
        release: admissionRelease,
      }),
    ).toThrow('branches cannot reconverge');
  });

  it('rejects hostile envelopes before invoking accessors or recursive parsing', () => {
    const admissionRelease = release();
    const accessor = vi.fn(() => {
      throw new Error('secret');
    });
    const getter = Object.defineProperty({}, 'schemaVersion', {
      get: accessor,
      enumerable: true,
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('secret');
        },
      },
    );
    let deep: unknown = null;
    for (let index = 0; index < 100; index += 1) deep = { child: deep };
    for (const envelope of [getter, cycle, proxy, { deep }])
      expect(() =>
        parseWorkflowExecutableV3({ envelope, admissionRelease }),
      ).toThrow(invalid);
    expect(accessor).not.toHaveBeenCalled();
  });
});
