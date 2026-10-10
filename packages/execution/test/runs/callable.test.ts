import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  settleCallableResult,
} from '@pertexo/workflow-engine';
import {
  CallableInputInvalidError,
  type CallableDeclaration,
  type JsonValue,
} from '@pertexo/workflow-model';
import { describe, expect, it, vi } from 'vitest';
import { createInitialCheckpoint } from '../../src/runs/initial-checkpoint.js';
import { resolveRunResult } from '../../src/runs/resolve-result.js';
import {
  VERSION_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  graph,
} from '../support/workflow.fixture.js';

const callable: CallableDeclaration = {
  input: { type: 'string' },
  resultType: { type: 'string' },
  result: { kind: 'run_input', path: '$' },
};
const signal = () => new AbortController().signal;
const values = (
  runInput: JsonValue | undefined,
  outputs: readonly {
    nodeId: string;
    invocationKey: string;
    value: JsonValue | undefined;
  }[] = [],
) => ({
  readCompletionValues: vi.fn(() => Promise.resolve({ runInput, outputs })),
});

describe('standalone callable contracts', () => {
  it('binds acceptance validation to the exact immutable contract', () => {
    const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);
    const executable = buildWorkflowExecutable({
      graph: { ...graph(), callable },
      catalog,
    });
    const projection = {
      id: VERSION_ID,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      versionNumber: 1,
      checksum: executable.checksum,
      executableJson: executable.envelope,
    };
    const initial = createInitialCheckpoint(projection, { catalog });
    expect(initial.validateInput).toBeTypeOf('function');
    expect(() => initial.validateInput?.('hello', 30)).not.toThrow();
    expect(() => initial.validateInput?.(2, 25)).toThrow(
      CallableInputInvalidError,
    );
    expect(() => initial.validateInput?.(undefined, 0)).toThrow(
      expect.objectContaining({ reason: 'missing' }),
    );
    expect(() => initial.validateInput?.('hello', 262_145)).toThrow(
      expect.objectContaining({ reason: 'bounds' }),
    );
    const ordinary = buildWorkflowExecutable({ graph: graph(), catalog });
    expect(
      createInitialCheckpoint(
        {
          ...projection,
          checksum: ordinary.checksum,
          executableJson: ordinary.envelope,
        },
        { catalog },
      ).validateInput,
    ).toBeUndefined();
    expect(() =>
      createInitialCheckpoint(
        { ...projection, checksum: ordinary.checksum },
        { catalog },
      ),
    ).toThrow();
  });

  it('resolves explicit input, literal and node-output results', async () => {
    expect(await resolveRunResult(callable, values('hello'), signal())).toEqual(
      { kind: 'valid', value: 'hello' },
    );
    expect(
      await resolveRunResult(
        { ...callable, result: { kind: 'literal', value: 'fixed' } },
        values(undefined),
        signal(),
      ),
    ).toEqual({ kind: 'valid', value: 'fixed' });
    const source = values('input', [
      {
        nodeId: 'step',
        invocationKey: 'scoped-step',
        value: { text: 'result' },
      },
    ]);
    expect(
      await resolveRunResult(
        {
          ...callable,
          result: { kind: 'node_output', nodeId: 'step', path: '$.text' },
        },
        source,
        signal(),
      ),
    ).toEqual({ kind: 'valid', value: 'result' });
    expect(source.readCompletionValues).toHaveBeenCalledWith(['step']);
  });

  it('refuses missing, artifact-only and ambiguous output, even with equal values', async () => {
    const declaration = {
      ...callable,
      result: { kind: 'node_output' as const, nodeId: 'step', path: '$' },
    };
    expect(
      await resolveRunResult(declaration, values('input'), signal()),
    ).toEqual({ kind: 'invalid', reasonCode: 'callable_result_missing' });
    expect(
      await resolveRunResult(
        declaration,
        values('input', [
          { nodeId: 'step', invocationKey: 'one', value: undefined },
        ]),
        signal(),
      ),
    ).toEqual({ kind: 'invalid', reasonCode: 'callable_result_invalid' });
    expect(
      await resolveRunResult(
        declaration,
        values('input', [
          { nodeId: 'step', invocationKey: 'one', value: 'same' },
          { nodeId: 'step', invocationKey: 'two', value: 'same' },
        ]),
        signal(),
      ),
    ).toEqual({ kind: 'invalid', reasonCode: 'callable_result_ambiguous' });
    expect(
      await resolveRunResult(
        { ...callable, result: { kind: 'run_input', path: '$.missing' } },
        values({}),
        signal(),
      ),
    ).toEqual({ kind: 'invalid', reasonCode: 'callable_result_missing' });
  });

  it('checks result type and existing inline limits including the stored wrapper', async () => {
    expect(await resolveRunResult(callable, values(1), signal())).toEqual({
      kind: 'invalid',
      reasonCode: 'callable_result_invalid',
    });
    const overhead = Buffer.byteLength(
      JSON.stringify({ kind: 'inline', value: '' }),
    );
    const exact = 'a'.repeat(262_144 - overhead);
    expect(await resolveRunResult(callable, values(exact), signal())).toEqual({
      kind: 'valid',
      value: exact,
    });
    expect(
      await resolveRunResult(callable, values(`${exact}a`), signal()),
    ).toEqual({ kind: 'invalid', reasonCode: 'callable_result_bounds' });
    const declaration = {
      ...callable,
      resultType: {
        type: 'array' as const,
        items: { type: 'null' as const },
        maxItems: 10_000,
      },
    };
    expect(
      await resolveRunResult(
        declaration,
        values(Array.from({ length: 10_001 }, () => null)),
        signal(),
      ),
    ).toEqual({ kind: 'invalid', reasonCode: 'callable_result_bounds' });
  });

  it('uses the existing evaluator and propagates cancellation', async () => {
    const evaluator = {
      evaluate: vi.fn(() =>
        Promise.resolve({
          kind: 'value' as const,
          value: 'mapped',
          canonicalBytes: 8,
        }),
      ),
    };
    const declaration = {
      ...callable,
      result: {
        kind: 'expression' as const,
        language: 'jsonata' as const,
        expression: '$string(runInput)',
      },
    };
    expect(
      await resolveRunResult(declaration, values(1), signal(), evaluator),
    ).toEqual({ kind: 'valid', value: 'mapped' });
    expect(evaluator.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ context: { runInput: 1, nodeOutputs: {} } }),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolveRunResult(callable, values('hello'), controller.signal),
    ).rejects.toThrow();
  });

  it('settles a provisional success with one safe event, without changing node outcomes', () => {
    const checkpoint = createCheckpoint({
      workflowVersionId: VERSION_ID,
      iterationBudget: 0,
    });
    const plan = {
      expectedRevision: 0,
      expectedNextEventSequence: 1,
      consumedThroughEventSequence: 0,
      checkpoint: { ...checkpoint, runStatus: 'succeeded' as const },
      events: [
        {
          sequence: 1,
          name: 'run.succeeded' as const,
          occurredAt: '2026-10-11T00:00:00.000Z',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    };
    expect(
      settleCallableResult(plan, { kind: 'valid', value: 'hello' }),
    ).toMatchObject({
      runResult: 'hello',
      checkpoint: { runStatus: 'succeeded' },
    });
    const failed = settleCallableResult(plan, {
      kind: 'invalid',
      reasonCode: 'callable_result_missing',
    });
    expect(failed).toMatchObject({
      checkpoint: { runStatus: 'failed' },
      events: [
        {
          name: 'run.failed',
          sequence: 1,
          reasonCode: 'callable_result_missing',
        },
      ],
    });
    expect(failed.checkpoint.invocations).toEqual(plan.checkpoint.invocations);
    expect(plan.checkpoint.runStatus).toBe('succeeded');
    expect(() =>
      settleCallableResult(
        { ...plan, events: [] },
        { kind: 'valid', value: null },
      ),
    ).toThrow();
  });
});
