import { createHash } from 'node:crypto';
import { NODE_JSON_LIMITS_V1 } from '@pertexo/node-sdk';
import { canonicalJson } from '@pertexo/workflow-model/canonical-json';
import { JsonataEvaluator } from '@pertexo/workflow-model/expressions';
import { resolveValueSource } from '@pertexo/workflow-model/mapping';
import { describe, expect, it, vi } from 'vitest';
import type { ExecuteNodeAttemptInput } from '../src/attempt/node-attempt-contract.js';
import { prepareNodeAttemptInput } from '../src/attempt/node-attempt-input.js';
import {
  buildWorkflowExecutableV2,
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityRelease,
  composeExecutableCompatibilityReleaseV3,
} from '../src/executable-workflow.js';
import { invocationKey } from '../src/transition/scheduling.js';
import {
  conditionGraph,
  forEachGraph,
  graph,
  nodeRelease,
} from './executable-workflow.fixtures.js';

const versionId = '00000000-0000-4000-8000-000000000001';
const otherVersionId = '00000000-0000-4000-8000-000000000002';
const sourceKey = invocationKey({
  workflowVersionId: versionId,
  nodeId: 'manual',
});
const v3 = buildWorkflowExecutableV3({
  graph: { ...graph(), schemaVersion: 2 },
  release: composeExecutableCompatibilityReleaseV3(nodeRelease()),
});
const v2 = buildWorkflowExecutableV2({
  graph: graph(),
  release: composeExecutableCompatibilityRelease(nodeRelease()),
});
const invalid: unknown = expect.objectContaining({ code: 'attempt_invalid' });

function descriptor(
  value: unknown = { value: 7 },
  patch: Record<string, unknown> = {},
) {
  return { invocationKey: sourceKey, nodeId: 'manual', value, ...patch };
}

function attempt(
  patch: Partial<ExecuteNodeAttemptInput> = {},
): ExecuteNodeAttemptInput {
  return {
    runId: 'run',
    nodeRunId: 'node-run',
    attemptId: 'attempt',
    executable: v3,
    workflowVersionId: versionId,
    invocationKey: invocationKey({
      workflowVersionId: versionId,
      nodeId: 'set',
    }),
    nodeId: 'set',
    runInput: {},
    completedNodeOutputs: [descriptor()],
    registry: {
      execute: vi.fn(() =>
        Promise.resolve({ kind: 'succeeded' as const, output: null }),
      ),
    },
    signal: new AbortController().signal,
    ...patch,
  };
}

function exactValue() {
  const overhead = Buffer.byteLength(JSON.stringify({ padding: '', value: 7 }));
  return {
    padding: 'x'.repeat(NODE_JSON_LIMITS_V1.bytes - overhead),
    value: 7,
  };
}

function scopedAttempt(patch: Partial<ExecuteNodeAttemptInput> = {}) {
  const iterationPath = [{ loopNodeId: 'loop', ordinal: 1 }];
  const collection = ['first', 'second'];
  const executable = buildWorkflowExecutableV3({
    graph: { ...forEachGraph(), schemaVersion: 2 },
    release: composeExecutableCompatibilityReleaseV3(
      nodeRelease({ forEach: true }),
    ),
  });
  return attempt({
    executable,
    nodeId: 'body-sink',
    iterationPath,
    invocationKey: invocationKey({
      workflowVersionId: versionId,
      nodeId: 'body-sink',
      iterationPath,
    }),
    completedNodeOutputs: [
      {
        invocationKey: invocationKey({
          workflowVersionId: versionId,
          nodeId: 'body-first',
          iterationPath,
        }),
        nodeId: 'body-first',
        value: { value: 7 },
      },
    ],
    structuredCollection: {
      loopNodeId: 'loop',
      ordinal: 1,
      collection,
      collectionSize: 2,
      declaredCollectionChecksum: createHash('sha256')
        .update(canonicalJson(collection))
        .digest('hex'),
    },
    ...patch,
  });
}

describe('V3 source-local completed output preparation', () => {
  it('admits exactly 1MiB independently of descriptor metadata and directly selects a small value', async () => {
    const value = exactValue();
    const completedNodeOutputs = [descriptor(value)];
    expect(Buffer.byteLength(JSON.stringify(value))).toBe(
      NODE_JSON_LIMITS_V1.bytes,
    );
    expect(
      Buffer.byteLength(JSON.stringify(completedNodeOutputs)),
    ).toBeGreaterThan(NODE_JSON_LIMITS_V1.bytes);
    const prepared = prepareNodeAttemptInput(attempt({ completedNodeOutputs }));
    expect(prepared.completedOutputs.manual).toEqual(value);
    expect(prepared.directUpstream).toEqual(new Set(['manual']));
    expect(
      await resolveValueSource(
        { kind: 'node_output', nodeId: 'manual', path: '$.value' },
        { runInput: prepared.runInput, nodeOutputs: prepared.completedOutputs },
      ),
    ).toEqual({ kind: 'value', value: 7 });
  });

  it('admits a legacy root map with independent value and key budgets', () => {
    const value = exactValue();
    expect(
      prepareNodeAttemptInput(
        attempt({ completedNodeOutputs: { manual: value } }),
      ).completedOutputs.manual,
    ).toEqual(value);
    expect(() =>
      prepareNodeAttemptInput(
        attempt({ executable: v2, completedNodeOutputs: { manual: value } }),
      ),
    ).toThrow(invalid);
  });

  it('retains the existing restricted-expression aggregate context bound', async () => {
    const prepared = prepareNodeAttemptInput(
      attempt({
        completedNodeOutputs: [descriptor(exactValue())],
      }),
    );
    const evaluator = new JsonataEvaluator();
    try {
      expect(
        await resolveValueSource(
          {
            kind: 'expression',
            language: 'jsonata',
            expression: 'nodeOutputs.manual.value',
            policyVersion: 1,
          },
          {
            runInput: prepared.runInput,
            nodeOutputs: prepared.completedOutputs,
          },
          evaluator,
        ),
      ).toMatchObject({
        kind: 'error',
        code: 'expression_error',
        expression: { code: 'limit_exceeded', limit: 'input_bytes' },
      });
    } finally {
      await evaluator.shutdown();
    }
  });

  it('retains the exact V2 aggregate descriptor-wrapper byte failure', () => {
    expect(() =>
      prepareNodeAttemptInput(
        attempt({
          executable: v2,
          completedNodeOutputs: [descriptor(exactValue())],
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'attempt_invalid',
        message: 'executable envelope exceeds maximum bytes',
      }),
    );
    expect(
      prepareNodeAttemptInput(attempt({ executable: v2 })).completedOutputs
        .manual,
    ).toEqual({ value: 7 });
  });

  it('deduplicates identical independently bounded descriptors without aggregate value rejection', () => {
    const value = exactValue();
    const prepared = prepareNodeAttemptInput(
      attempt({ completedNodeOutputs: [descriptor(value), descriptor(value)] }),
    );
    expect(Object.keys(prepared.completedOutputs)).toEqual(['manual']);
    expect(prepared.completedOutputs.manual).toEqual(value);
  });

  it('retains one independently frozen source for many repeated1MiB descriptors', () => {
    const value = exactValue();
    const completedNodeOutputs = Array.from({ length: 128 }, () =>
      descriptor(value),
    );
    const prepared = prepareNodeAttemptInput(attempt({ completedNodeOutputs }));
    expect(Object.keys(prepared.completedOutputs)).toEqual(['manual']);
    expect(prepared.completedOutputs.manual).toEqual(value);
    expect(prepared.completedOutputs.manual).not.toBe(value);
    expect(Object.isFrozen(prepared.completedOutputs.manual)).toBe(true);
    expect(Object.isFrozen(prepared.completedOutputs)).toBe(true);
    expect(Object.isFrozen(value)).toBe(false);
  });

  it('owns normalized source snapshots without changing caller values', () => {
    const value = { value: 7, nested: { keep: true } };
    const prepared = prepareNodeAttemptInput(
      attempt({ completedNodeOutputs: [descriptor(value)] }),
    );
    value.nested.keep = false;
    expect(prepared.completedOutputs.manual).toEqual({
      value: 7,
      nested: { keep: true },
    });
    const normalized = prepared.completedOutputs.manual;
    expect(Object.isFrozen(normalized)).toBe(true);
    if (normalized === null || typeof normalized !== 'object')
      throw new Error('normalized record missing');
    const nested: unknown = Object.getOwnPropertyDescriptor(
      normalized,
      'nested',
    )?.value;
    expect(nested).toEqual({ keep: true });
    expect(Object.isFrozen(nested)).toBe(true);
    const next = prepareNodeAttemptInput(
      attempt({ completedNodeOutputs: [descriptor(value), descriptor(value)] }),
    );
    expect(next.completedOutputs.manual).toEqual({
      value: 7,
      nested: { keep: false },
    });
    expect(prepared.completedOutputs.manual).toEqual({
      value: 7,
      nested: { keep: true },
    });
  });

  it.each(['conflicting', 'oversized', 'accessor'])(
    'still validates a distinct %s source after repeated accepted descriptors',
    (kind) => {
      const value = exactValue();
      const getter = vi.fn(() => 'private');
      const other =
        kind === 'accessor'
          ? Object.defineProperty({}, 'padding', {
              enumerable: true,
              get: getter,
            })
          : kind === 'oversized'
            ? { ...value, padding: `${value.padding}x` }
            : { ...value, value: 8 };
      expect(() =>
        prepareNodeAttemptInput(
          attempt({
            completedNodeOutputs: [
              ...Array.from({ length: 128 }, () => descriptor(value)),
              descriptor(other),
            ],
          }),
        ),
      ).toThrow(invalid);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it('rejects one byte beyond the independent source value bound', () => {
    const value = exactValue();
    value.padding += 'x';
    expect(() =>
      prepareNodeAttemptInput(
        attempt({ completedNodeOutputs: [descriptor(value)] }),
      ),
    ).toThrow(invalid);
  });

  it('preserves per-source depth and member bounds', () => {
    let deep: unknown = null;
    for (let i = 0; i < NODE_JSON_LIMITS_V1.depth + 1; i++) deep = [deep];
    for (const value of [
      deep,
      Array.from({ length: NODE_JSON_LIMITS_V1.members + 1 }, () => null),
    ])
      expect(() =>
        prepareNodeAttemptInput(
          attempt({ completedNodeOutputs: [descriptor(value)] }),
        ),
      ).toThrow(invalid);
  });

  it('admits exact per-source depth/member boundaries without charging descriptor nesting', () => {
    let deep: unknown = null;
    for (let i = 0; i < NODE_JSON_LIMITS_V1.depth; i++) deep = [deep];
    const members = Array.from(
      { length: NODE_JSON_LIMITS_V1.members },
      () => null,
    );
    for (const value of [deep, members]) {
      expect(
        prepareNodeAttemptInput(
          attempt({ completedNodeOutputs: [descriptor(value)] }),
        ).completedOutputs.manual,
      ).toEqual(value);
      expect(() =>
        prepareNodeAttemptInput(
          attempt({
            executable: v2,
            completedNodeOutputs: [descriptor(value)],
          }),
        ),
      ).toThrow(invalid);
    }
  });

  it('rejects accessor values without invoking getters', () => {
    const getter = vi.fn(() => {
      throw new Error('private value');
    });
    const value = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: getter,
    });
    expect(() =>
      prepareNodeAttemptInput(
        attempt({ completedNodeOutputs: [descriptor(value)] }),
      ),
    ).toThrow(invalid);
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects accessor descriptor fields without invoking getters', () => {
    const getter = vi.fn(() => {
      throw new Error('private metadata');
    });
    for (const field of ['value', 'nodeId', 'invocationKey']) {
      const source = Object.defineProperty(descriptor(), field, {
        enumerable: true,
        get: getter,
      });
      expect(() =>
        prepareNodeAttemptInput(attempt({ completedNodeOutputs: [source] })),
      ).toThrow(invalid);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects array-index and legacy-map accessors without invoking getters', () => {
    const getter = vi.fn(() => {
      throw new Error('private metadata');
    });
    const array = Object.defineProperty([descriptor()], '0', {
      enumerable: true,
      get: getter,
    });
    const legacy = Object.defineProperty({}, 'manual', {
      enumerable: true,
      get: getter,
    });
    for (const completedNodeOutputs of [array, legacy])
      expect(() =>
        prepareNodeAttemptInput(attempt({ completedNodeOutputs })),
      ).toThrow(invalid);
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects proxy arrays, descriptors, maps and nested values before proxy traps', () => {
    const trap = vi.fn(() => {
      throw new Error('private proxy');
    });
    const proxy = new Proxy(
      {},
      { ownKeys: trap, getPrototypeOf: trap, get: trap },
    );
    const array = new Proxy([], { ownKeys: trap, get: trap });
    for (const completedNodeOutputs of [
      proxy,
      array,
      [proxy],
      [descriptor({ nested: proxy })],
    ])
      expect(() =>
        prepareNodeAttemptInput(attempt({ completedNodeOutputs })),
      ).toThrow(invalid);
    expect(trap).not.toHaveBeenCalled();
  });

  it.each([
    [descriptor({ value: 7 }), descriptor({ value: 8 })],
    [descriptor({ value: 8 }), descriptor({ value: 7 })],
  ])(
    'rejects conflicting same-source evidence %#',
    (...completedNodeOutputs) => {
      expect(() =>
        prepareNodeAttemptInput(attempt({ completedNodeOutputs })),
      ).toThrow(
        expect.objectContaining({
          code: 'attempt_invalid',
          message: 'completed outputs conflict',
        }),
      );
    },
  );

  it.each([
    { nodeId: 'terminate' },
    { invocationKey: 'inexact' },
    {
      invocationKey: invocationKey({
        workflowVersionId: otherVersionId,
        nodeId: 'manual',
      }),
    },
    { extra: true },
    { value: undefined },
  ])('rejects inexact or malformed upstream descriptor %#', (patch) => {
    expect(() =>
      prepareNodeAttemptInput(
        attempt({ completedNodeOutputs: [descriptor(undefined, patch)] }),
      ),
    ).toThrow(invalid);
  });

  it('rejects non-direct legacy upstream keys', () => {
    expect(() =>
      prepareNodeAttemptInput(
        attempt({ completedNodeOutputs: { terminate: {} } }),
      ),
    ).toThrow(invalid);
  });

  it('validates every descriptor identity before inspecting even a preceding hostile source', () => {
    const getter = vi.fn(() => {
      throw new Error('private source');
    });
    const hostile = Object.defineProperty({}, 'private', {
      enumerable: true,
      get: getter,
    });
    expect(() =>
      prepareNodeAttemptInput(
        attempt({
          completedNodeOutputs: [
            descriptor(hostile),
            descriptor(hostile, { nodeId: 'terminate' }),
          ],
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'attempt_invalid',
        message: 'completed output invocation is not exact upstream',
      }),
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it('validates every legacy-map key before inspecting any source value', () => {
    const getter = vi.fn(() => {
      throw new Error('private source');
    });
    const hostile = Object.defineProperty({}, 'private', {
      enumerable: true,
      get: getter,
    });
    expect(() =>
      prepareNodeAttemptInput(
        attempt({
          completedNodeOutputs: { manual: hostile, terminate: hostile },
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'attempt_invalid',
        message: 'completed output is not direct upstream',
      }),
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it('bounds metadata separately including source count and aggregate metadata size', () => {
    for (const completedNodeOutputs of [
      Array(NODE_JSON_LIMITS_V1.members + 1).fill(descriptor()),
      [descriptor(null, { nodeId: 'x'.repeat(NODE_JSON_LIMITS_V1.bytes) })],
      Object.fromEntries(
        Array.from({ length: NODE_JSON_LIMITS_V1.members + 1 }, (_, index) => [
          String(index),
          null,
        ]),
      ),
    ])
      expect(() =>
        prepareNodeAttemptInput(attempt({ completedNodeOutputs })),
      ).toThrow(invalid);
  });

  it('rejects sparse arrays and extra/hidden/symbol descriptor fields', () => {
    const hidden = Object.defineProperty(descriptor(), 'hidden', {
      value: true,
    });
    const symbol = { ...descriptor(), [Symbol('hidden')]: true };
    const extraArray = Object.assign([descriptor()], { extra: true });
    for (const completedNodeOutputs of [
      Array(1),
      extraArray,
      [hidden],
      [symbol],
    ])
      expect(() =>
        prepareNodeAttemptInput(attempt({ completedNodeOutputs })),
      ).toThrow(invalid);
  });

  it('rejects custom-prototype metadata and inherited sources', () => {
    const candidate = Object.assign(
      Object.create({ inherited: true }) as object,
      descriptor(),
    );
    const legacy = Object.create({ manual: {} }) as unknown;
    for (const completedNodeOutputs of [[candidate], legacy])
      expect(() =>
        prepareNodeAttemptInput(attempt({ completedNodeOutputs })),
      ).toThrow(invalid);
  });

  it('preserves exact loop-scoped upstream proofs with an independent1MiB source', () => {
    const input = scopedAttempt();
    const output = (
      input.completedNodeOutputs as readonly Record<string, unknown>[]
    )[0];
    expect(
      prepareNodeAttemptInput({
        ...input,
        completedNodeOutputs: [{ ...output, value: exactValue() }],
      }).completedOutputs['body-first'],
    ).toEqual(exactValue());
    expect(() =>
      prepareNodeAttemptInput({
        ...input,
        completedNodeOutputs: [
          {
            ...output,
            invocationKey: invocationKey({
              workflowVersionId: versionId,
              nodeId: 'body-first',
              iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
            }),
          },
        ],
      }),
    ).toThrow(invalid);
    expect(() =>
      prepareNodeAttemptInput({
        ...input,
        completedNodeOutputs: { 'body-first': {} },
      }),
    ).toThrow(invalid);
  });

  it('requires V3 branch descriptors but preserves retained V2 legacy-map behavior', () => {
    const branchPath = [{ nodeId: 'condition', outputPort: 'true' }];
    const source = conditionGraph('true');
    const input = attempt({
      executable: buildWorkflowExecutableV3({
        graph: { ...source, schemaVersion: 2 },
        release: composeExecutableCompatibilityReleaseV3(
          nodeRelease({ condition: true }),
        ),
      }),
      nodeId: 'terminate',
      branchPath,
      invocationKey: invocationKey({
        workflowVersionId: versionId,
        nodeId: 'terminate',
        branchPath: ['condition:true'],
      }),
      completedNodeOutputs: { condition: { value: 7 } },
    });
    expect(() => prepareNodeAttemptInput(input)).toThrow(invalid);
    expect(
      prepareNodeAttemptInput({
        ...input,
        executable: buildWorkflowExecutableV2({
          graph: source,
          release: composeExecutableCompatibilityRelease(
            nodeRelease({ condition: true }),
          ),
        }),
      }).completedOutputs.condition,
    ).toEqual({ value: 7 });
    expect(
      prepareNodeAttemptInput({
        ...input,
        completedNodeOutputs: [
          {
            nodeId: 'condition',
            invocationKey: invocationKey({
              workflowVersionId: versionId,
              nodeId: 'condition',
            }),
            value: { value: 7 },
          },
        ],
      }).completedOutputs.condition,
    ).toEqual({ value: 7 });
    expect(() =>
      prepareNodeAttemptInput({
        ...input,
        completedNodeOutputs: [
          {
            nodeId: 'condition',
            invocationKey: invocationKey({
              workflowVersionId: versionId,
              nodeId: 'condition',
              branchPath: ['condition:true'],
            }),
            value: { value: 7 },
          },
        ],
      }),
    ).toThrow(invalid);
  });
});
