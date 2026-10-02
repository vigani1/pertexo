import { describe, expect, it } from 'vitest';
import type { WorkflowCallableDeclarationV1 } from '@pertexo/workflow-model/callable-graph-contract';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/expressions';
import type { ValueSource } from '@pertexo/workflow-model/graph-contract';
import { workflowCallableContractIdentityV1 } from '@pertexo/workflow-model/workflow-call-closure';
import {
  resolveWorkflowCallableResultV1,
  validateWorkflowCallInputV1,
} from '../src/workflow-call-values.js';

const declaration = (
  resultSelector: ValueSource = {
    kind: 'node_output',
    nodeId: 'selected',
    path: '$',
  },
): WorkflowCallableDeclarationV1 => ({
  schemaVersion: 1,
  input: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
  result: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
  resultSelector,
});
const pin = (source = declaration()) => ({
  workflowId: '00000001-0000-4000-8000-000000000001',
  versionId: '00000002-0000-4000-8000-000000000002',
  checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
  callableContractIdentity: workflowCallableContractIdentityV1(source),
});
const signal = () => new AbortController().signal;

describe('exact callable input validation', () => {
  it('validates the exact declaration hash and freezes an independent bounded record', () => {
    const source = declaration();
    const value = { name: 'accepted' };
    const result = validateWorkflowCallInputV1({
      pin: pin(source),
      declaration: source,
      value,
    });
    expect(result).toEqual({ ok: true, value });
    value.name = 'changed';
    if (!result.ok) throw new Error('Expected valid fixture');
    expect(result.value).toEqual({ name: 'accepted' });
    expect(Object.isFrozen(result.value)).toBe(true);
  });
  it.each([
    { name: 1 },
    {},
    { name: 'accepted', extra: true },
    null,
    ['accepted'],
    { name: NaN },
    { name: Infinity },
  ])('rejects invalid input safely %#', (value) => {
    expect(
      validateWorkflowCallInputV1({
        pin: pin(),
        declaration: declaration(),
        value,
      }),
    ).toEqual({ ok: false, reasonCode: 'workflow.child_input_invalid' });
  });
  it('preserves the exact independent JSON byte boundary', () => {
    const overhead = JSON.stringify({ name: '' }).length;
    expect(
      validateWorkflowCallInputV1({
        pin: pin(),
        declaration: declaration(),
        value: { name: 'a'.repeat(1_048_576 - overhead) },
      }).ok,
    ).toBe(true);
    expect(
      validateWorkflowCallInputV1({
        pin: pin(),
        declaration: declaration(),
        value: { name: 'secret'.repeat(200_000) },
      }),
    ).toEqual({ ok: false, reasonCode: 'workflow.child_input_invalid' });
    expect(
      validateWorkflowCallInputV1({
        pin: pin(),
        declaration: declaration(),
        value: { name: 'a'.repeat(1_048_577 - overhead) },
      }).ok,
    ).toBe(false);
  });
  it('treats pin/declaration identity mismatch as an operational executable failure', () => {
    expect(() =>
      validateWorkflowCallInputV1({
        pin: {
          ...pin(),
          callableContractIdentity: `callable:v1:sha256:${'b'.repeat(64)}`,
        },
        declaration: declaration(),
        value: { name: 'secret' },
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });
  it('rejects accessor/cyclic values without executing them or leaking diagnostics', () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, 'name', {
      enumerable: true,
      get() {
        reads += 1;
        return 'secret';
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.name = cyclic;
    for (const value of [
      accessor,
      cyclic,
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('secret');
          },
        },
      ),
    ])
      expect(
        validateWorkflowCallInputV1({
          pin: pin(),
          declaration: declaration(),
          value,
        }),
      ).toEqual({ ok: false, reasonCode: 'workflow.child_input_invalid' });
    expect(reads).toBe(0);
  });
});

describe('explicit bounded callable result resolution', () => {
  it('resolves only explicit node output, run input and literal selectors', async () => {
    for (const resultSelector of [
      { kind: 'node_output', nodeId: 'selected', path: '$.payload' },
      { kind: 'run_input', path: '$.payload' },
      { kind: 'literal', value: { name: 'accepted' } },
    ] satisfies ValueSource[]) {
      expect(
        await resolveWorkflowCallableResultV1({
          declaration: declaration(resultSelector),
          runInput: { payload: { name: 'accepted' } },
          nodeOutputs: {
            selected: { payload: { name: 'accepted' } },
            last: { name: 'wrong' },
          },
          signal: signal(),
        }),
      ).toEqual({ ok: true, value: { name: 'accepted' } });
    }
  });
  it('never replaces missing/skipped selection with last-node/all-output/null fallback', async () => {
    for (const resultSelector of [
      { kind: 'node_output', nodeId: 'skipped', path: '$' },
      { kind: 'node_output', nodeId: 'selected', path: '$.absent' },
      { kind: 'run_input', path: '$.absent' },
    ] satisfies ValueSource[])
      expect(
        await resolveWorkflowCallableResultV1({
          declaration: declaration(resultSelector),
          runInput: { name: 'accepted' },
          nodeOutputs: {
            selected: { name: 'accepted' },
            last: { name: 'accepted' },
          },
          signal: signal(),
        }),
      ).toEqual({ ok: false, reasonCode: 'workflow.child_result_missing' });
  });
  it.each([
    null,
    1,
    'secret',
    {},
    { name: false },
    { name: 'accepted', secret: 'not disclosed' },
  ])('rejects selected invalid/closed result %#', async (value) => {
    expect(
      await resolveWorkflowCallableResultV1({
        declaration: declaration({ kind: 'literal', value }),
        runInput: {},
        nodeOutputs: {},
        signal: signal(),
      }),
    ).toEqual({ ok: false, reasonCode: 'workflow.child_result_invalid' });
  });
  it('classifies invalid mapping paths safely', async () => {
    expect(
      await resolveWorkflowCallableResultV1({
        declaration: declaration({ kind: 'run_input', path: '$.items[*]' }),
        runInput: { items: [{ name: 'accepted' }] },
        nodeOutputs: {},
        signal: signal(),
      }),
    ).toEqual({ ok: false, reasonCode: 'workflow.child_result_invalid' });
  });
  it('delegates expressions to the injected existing evaluator with exact context and signal', async () => {
    let calls = 0;
    const abortSignal = signal();
    const evaluator: ExpressionEvaluator = {
      evaluate(request) {
        calls += 1;
        expect(request).toEqual({
          expression: 'runInput.payload',
          policyVersion: 1,
          context: {
            runInput: { payload: { name: 'accepted' } },
            nodeOutputs: { last: { name: 'wrong' } },
          },
          signal: abortSignal,
        });
        return Promise.resolve({
          kind: 'value',
          value: { name: 'accepted' },
          canonicalBytes: 19,
        });
      },
    };
    expect(
      await resolveWorkflowCallableResultV1({
        declaration: declaration({
          kind: 'expression',
          language: 'jsonata',
          expression: 'runInput.payload',
          policyVersion: 1,
        }),
        runInput: { payload: { name: 'accepted' } },
        nodeOutputs: { last: { name: 'wrong' } },
        expressionEvaluator: evaluator,
        signal: abortSignal,
      }),
    ).toEqual({ ok: true, value: { name: 'accepted' } });
    expect(calls).toBe(1);
  });
  it('has no new evaluator fallback and preserves existing expression missing/error classifications', async () => {
    const source = declaration({
      kind: 'expression',
      language: 'jsonata',
      expression: 'runInput.payload',
      policyVersion: 1,
    });
    const base = {
      declaration: source,
      runInput: {},
      nodeOutputs: {},
      signal: signal(),
    };
    expect(await resolveWorkflowCallableResultV1(base)).toEqual({
      ok: false,
      reasonCode: 'workflow.child_result_invalid',
    });
    expect(
      await resolveWorkflowCallableResultV1({
        ...base,
        expressionEvaluator: {
          evaluate: () => Promise.resolve({ kind: 'missing' }),
        },
      }),
    ).toEqual({ ok: false, reasonCode: 'workflow.child_result_missing' });
    expect(
      await resolveWorkflowCallableResultV1({
        ...base,
        expressionEvaluator: {
          evaluate: () =>
            Promise.resolve({
              kind: 'error',
              code: 'evaluation_failed',
              message: 'secret',
            }),
        },
      }),
    ).toEqual({ ok: false, reasonCode: 'workflow.child_result_invalid' });
  });
  it('propagates abort before evaluation without invoking an evaluator', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      resolveWorkflowCallableResultV1({
        declaration: declaration({
          kind: 'expression',
          language: 'jsonata',
          expression: 'runInput',
          policyVersion: 1,
        }),
        runInput: {},
        nodeOutputs: {},
        signal: controller.signal,
        expressionEvaluator: {
          evaluate() {
            calls += 1;
            return Promise.resolve({ kind: 'missing' });
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'attempt_aborted' });
    expect(calls).toBe(0);
  });
  it('propagates abort after pure evaluation instead of accepting a result', async () => {
    const controller = new AbortController();
    await expect(
      resolveWorkflowCallableResultV1({
        declaration: declaration({
          kind: 'expression',
          language: 'jsonata',
          expression: 'runInput',
          policyVersion: 1,
        }),
        runInput: { name: 'accepted' },
        nodeOutputs: {},
        signal: controller.signal,
        expressionEvaluator: {
          evaluate() {
            controller.abort();
            return Promise.resolve({
              kind: 'value',
              value: { name: 'accepted' },
              canonicalBytes: 19,
            });
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'attempt_aborted' });
  });
  it('does not execute hostile output accessors before bounded result admission', async () => {
    let reads = 0;
    const nodeOutputs = {
      get selected() {
        reads += 1;
        return { name: 'secret' };
      },
    };
    expect(
      await resolveWorkflowCallableResultV1({
        declaration: declaration(),
        runInput: {},
        nodeOutputs,
        signal: signal(),
      }),
    ).toEqual({ ok: false, reasonCode: 'workflow.child_result_invalid' });
    expect(reads).toBe(0);
  });
  it('normalizes evaluator rejection after abort without swallowing operational failures', async () => {
    const operationalError = new Error('operational evaluator failure');
    for (const abort of [false, true]) {
      const controller = new AbortController();
      const operation = resolveWorkflowCallableResultV1({
        declaration: declaration({
          kind: 'expression',
          language: 'jsonata',
          expression: 'runInput',
          policyVersion: 1,
        }),
        runInput: {},
        nodeOutputs: {},
        signal: controller.signal,
        expressionEvaluator: {
          evaluate() {
            if (abort) controller.abort();
            return Promise.reject(operationalError);
          },
        },
      });
      if (abort)
        await expect(operation).rejects.toMatchObject({
          code: 'attempt_aborted',
        });
      else await expect(operation).rejects.toBe(operationalError);
    }
  });
  it('rejects a hostile declaration without evaluating its selector getter', async () => {
    let reads = 0;
    const source = Object.defineProperty(declaration(), 'resultSelector', {
      enumerable: true,
      get() {
        reads += 1;
        return { kind: 'literal', value: { name: 'secret' } };
      },
    });
    await expect(
      resolveWorkflowCallableResultV1({
        declaration: source,
        runInput: {},
        nodeOutputs: {},
        signal: signal(),
      }),
    ).rejects.toMatchObject({ code: 'executable_invalid' });
    expect(reads).toBe(0);
  });
  it('rejects hostile nested context, nonfinite result data and oversized results safely', async () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, 'name', {
      enumerable: true,
      get() {
        reads += 1;
        return 'secret';
      },
    });
    for (const value of [
      accessor,
      { name: NaN },
      { name: Infinity },
      { name: 'secret'.repeat(200_000) },
    ])
      expect(
        await resolveWorkflowCallableResultV1({
          declaration: declaration(),
          runInput: {},
          nodeOutputs: { selected: value },
          signal: signal(),
        }),
      ).toEqual({ ok: false, reasonCode: 'workflow.child_result_invalid' });
    expect(
      await resolveWorkflowCallableResultV1({
        declaration: declaration({ kind: 'run_input', path: '$' }),
        runInput: accessor,
        nodeOutputs: {},
        signal: signal(),
      }),
    ).toEqual({ ok: false, reasonCode: 'workflow.child_result_invalid' });
    expect(reads).toBe(0);
  });
});

describe('hostile retained callable metadata', () => {
  it('never invokes pin or declaration getters and uses safe operational errors', () => {
    let reads = 0;
    const pinGetter = Object.defineProperty(pin(), 'checksum', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('secret');
      },
    });
    const source = Object.defineProperty(declaration(), 'input', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('secret');
      },
    });
    for (const input of [
      {
        pin: pinGetter,
        declaration: declaration(),
        value: { name: 'accepted' },
      },
      { pin: pin(), declaration: source, value: { name: 'accepted' } },
      {
        pin: new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('secret');
            },
          },
        ),
        declaration: declaration(),
        value: { name: 'accepted' },
      },
      {
        pin: { ...pin(), extra: 'secret' },
        declaration: declaration(),
        value: { name: 'accepted' },
      },
    ]) {
      try {
        validateWorkflowCallInputV1(input);
      } catch (error) {
        expect(error).toMatchObject({ code: 'executable_invalid' });
        expect((error as Error).message).not.toContain('secret');
        continue;
      }
      throw new Error('Expected operational metadata failure');
    }
    expect(reads).toBe(0);
  });
});

describe('source-local callable result bounds', () => {
  it('ignores unrelated huge and accessor outputs for a direct node selector', async () => {
    let reads = 0;
    const nodeOutputs = {
      selected: { name: 'accepted' },
      huge: { name: 'unused'.repeat(200_000) },
      get unused(): never {
        reads += 1;
        throw new Error('unused getter executed');
      },
    };
    expect(
      await resolveWorkflowCallableResultV1({
        declaration: declaration(),
        runInput: { huge: 'unused'.repeat(200_000) },
        nodeOutputs,
        signal: signal(),
      }),
    ).toEqual({ ok: true, value: { name: 'accepted' } });
    expect(reads).toBe(0);
  });
  it('preserves the exact selected 1 MiB value boundary without wrapper overhead', async () => {
    const overhead = JSON.stringify({ name: '' }).length;
    const selected = { name: 'a'.repeat(1_048_576 - overhead) };
    const result = await resolveWorkflowCallableResultV1({
      declaration: declaration(),
      runInput: {},
      nodeOutputs: { selected },
      signal: signal(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected boundary value acceptance');
    expect(result.value).toEqual(selected);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(
      await resolveWorkflowCallableResultV1({
        declaration: declaration(),
        runInput: {},
        nodeOutputs: { selected: { name: `${selected.name}a` } },
        signal: signal(),
      }),
    ).toEqual({ ok: false, reasonCode: 'workflow.child_result_invalid' });
  });
  it('does not inspect unused run input or outputs for a literal result', async () => {
    let reads = 0;
    const runInput = {
      get unused(): never {
        reads += 1;
        throw new Error('unused getter executed');
      },
    };
    const nodeOutputs = {
      huge: { name: 'unused'.repeat(200_000) },
      get unused(): never {
        reads += 1;
        throw new Error('unused getter executed');
      },
    };
    expect(
      await resolveWorkflowCallableResultV1({
        declaration: declaration({
          kind: 'literal',
          value: { name: 'accepted' },
        }),
        runInput,
        nodeOutputs,
        signal: signal(),
      }),
    ).toEqual({ ok: true, value: { name: 'accepted' } });
    expect(reads).toBe(0);
  });
  it('does not inspect unused output context for a run input result', async () => {
    let reads = 0;
    const nodeOutputs = {
      get unused(): never {
        reads += 1;
        throw new Error('unused getter executed');
      },
    };
    expect(
      await resolveWorkflowCallableResultV1({
        declaration: declaration({ kind: 'run_input', path: '$' }),
        runInput: { name: 'accepted' },
        nodeOutputs,
        signal: signal(),
      }),
    ).toEqual({ ok: true, value: { name: 'accepted' } });
    expect(reads).toBe(0);
  });
  it('still enforces the existing aggregate context bound for expressions', async () => {
    let calls = 0;
    const evaluator: ExpressionEvaluator = {
      evaluate() {
        calls += 1;
        return Promise.resolve({
          kind: 'value',
          value: { name: 'accepted' },
          canonicalBytes: 19,
        });
      },
    };
    expect(
      await resolveWorkflowCallableResultV1({
        declaration: declaration({
          kind: 'expression',
          language: 'jsonata',
          expression: 'runInput',
          policyVersion: 1,
        }),
        runInput: { name: 'accepted' },
        nodeOutputs: { huge: { name: 'unused'.repeat(200_000) } },
        expressionEvaluator: evaluator,
        signal: signal(),
      }),
    ).toEqual({ ok: false, reasonCode: 'workflow.child_result_invalid' });
    expect(calls).toBe(0);
  });
});
