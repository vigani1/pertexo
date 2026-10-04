import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  authenticateCoordinatorCallResult,
  loadCoordinatorCallResultAuthentication,
  verifyCoordinatorCallResultAuthentication,
} from '../src/execution/coordinator/coordinator-call-result-authentication.js';
import { JsonataEvaluator } from '@pertexo/workflow-model/expressions';
import type { ParsedTransitionPlan } from '../src/execution/coordinator/coordinator-run-store-plan.js';

const id = '00000000-0000-4000-8000-000000000101';
const objectType = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
};
const node = {
  id: 'result',
  definition: { key: 'core.terminate', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
};
const source = {
  invocationKey: 'result-key',
  output: { kind: 'inline' as const, attemptId: id },
};
function fixture(
  selector: unknown = { kind: 'literal', value: { name: 'result' } },
) {
  const row = {
    executable_json: {
      schemaVersion: 3,
      graph: {
        schemaVersion: 2,
        nodes: [node],
        edges: [],
        settings: {},
        callable: {
          schemaVersion: 1,
          input: objectType,
          result: objectType,
          resultSelector: selector,
        },
      },
    },
    input_ref: { schemaVersion: 1, kind: 'inline', value: { name: 'input' } },
  };
  const query = vi.fn().mockResolvedValue({ rows: [row] });
  const plan = {
    callableResult: {
      kind: 'succeeded',
      value: { name: 'result' },
      sources: [],
    },
    checkpoint: {
      invocations: [{ ...source, nodeId: 'result', status: 'succeeded' }],
    },
  } as unknown as ParsedTransitionPlan;
  const input = {
    workspaceId: id,
    runId: id,
    workflowVersionId: id,
    plan,
    signal: new AbortController().signal,
    delivery: { outboxEventId: id, payloadChecksum: 'a'.repeat(64) },
  };
  return { query, input, client: { query } as unknown as PoolClient };
}
describe('immutable callable result authentication', () => {
  it.each(['exact', 'changed', 'invalid_contract'] as const)(
    'recomputes %s fresh expression context with the existing evaluator, without loading retained material',
    async (kind) => {
      const evaluator = new JsonataEvaluator();
      const evaluate = vi.spyOn(evaluator, 'evaluate');
      try {
        const f = fixture({
          kind: 'expression',
          language: 'jsonata',
          policyVersion: 1,
          expression: '{"name":runInput.name}',
        });
        const material = await loadCoordinatorCallResultAuthentication(
          f.client,
          {
            ...f.input,
            nativeSourceInventoryOnly: true,
            expressionEvaluator: evaluator,
          },
        );
        expect(material).toMatchObject({
          nativeDemand: { requiresRunInput: true, sources: [] },
        });
        expect(material).not.toHaveProperty('context');
        expect(f.query).toHaveBeenCalledOnce();
        expect(f.query.mock.calls[0]?.[0]).not.toContain('run.input_ref');
        expect(evaluate).not.toHaveBeenCalled();
        if (material === undefined) throw new Error('Missing fixture material');
        const result = verifyCoordinatorCallResultAuthentication(
          material,
          f.input.signal,
          evaluator,
          {
            runInput: {
              name:
                kind === 'exact'
                  ? 'result'
                  : kind === 'changed'
                    ? 'changed'
                    : 42,
            },
            nodeOutputs: {},
          },
        );
        if (kind === 'exact') await expect(result).resolves.toBeUndefined();
        else
          await expect(result).rejects.toMatchObject({
            name: 'CoordinatorPlanInvalidError',
          });
        expect(evaluate).toHaveBeenCalledOnce();
        expect(f.query).toHaveBeenCalledOnce();
      } finally {
        await evaluator.shutdown();
      }
    },
  );
  it('recomputes the pinned literal without reading unrelated outputs', async () => {
    const f = fixture();
    await authenticateCoordinatorCallResult(f.client, f.input);
    expect(f.query).toHaveBeenCalledOnce();
  });
  it.each([
    { name: 'substitution' },
    { name: 42 },
    { name: 'result', undeclared: true },
  ])('rejects substituted or untyped literal %j', async (value) => {
    const f = fixture();
    f.input.plan = {
      ...f.input.plan,
      callableResult: { kind: 'succeeded', value, sources: [] },
    };
    await expect(
      authenticateCoordinatorCallResult(f.client, f.input),
    ).rejects.toThrow();
  });
  it('rejects extra sources even when they belong to a succeeded invocation', async () => {
    const f = fixture();
    f.input.plan = {
      ...f.input.plan,
      callableResult: {
        kind: 'succeeded',
        value: { name: 'result' },
        sources: [source],
      },
    };
    await expect(
      authenticateCoordinatorCallResult(f.client, f.input),
    ).rejects.toThrow();
  });
  it('authenticates run input through its retained reference', async () => {
    const f = fixture({ kind: 'run_input', path: '$' });
    f.input.plan = {
      ...f.input.plan,
      callableResult: {
        kind: 'succeeded',
        value: { name: 'input' },
        sources: [],
      },
    };
    await authenticateCoordinatorCallResult(f.client, f.input);
    expect(f.query).toHaveBeenCalledOnce();
  });
  it('rejects missing selected source before hydration', async () => {
    const f = fixture({ kind: 'node_output', nodeId: 'result', path: '$' });
    await expect(
      authenticateCoordinatorCallResult(f.client, f.input),
    ).rejects.toThrow();
    expect(f.query).toHaveBeenCalledOnce();
  });
  it('rejects a forged selected source identity before hydration', async () => {
    const f = fixture({ kind: 'node_output', nodeId: 'result', path: '$' });
    f.input.plan = {
      ...f.input.plan,
      callableResult: {
        kind: 'succeeded',
        value: { name: 'result' },
        sources: [
          {
            ...source,
            output: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000102',
            },
          },
        ],
      },
    };
    await expect(
      authenticateCoordinatorCallResult(f.client, f.input),
    ).rejects.toThrow();
    expect(f.query).toHaveBeenCalledOnce();
  });
});
