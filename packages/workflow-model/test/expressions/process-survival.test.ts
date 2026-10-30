import { describe, expect, it } from 'vitest';

import {
  evaluateInRealProcess,
  type HostedEvaluation,
  type HostOutcome,
} from './survival/host.js';

/** One outcome read: what stopped the process, in the words a failure needs. */
function survived(outcome: HostOutcome): string {
  if (outcome.exitCode === 0 && outcome.signal === null) return 'survived';
  return [
    `process stopped: exit ${String(outcome.exitCode)} signal ${String(outcome.signal)}`,
    `running: ${outcome.unfinished.join(' | ')}`,
    outcome.crashOutput,
  ].join('\n');
}

/** An over-limit expression fails with its own error, never a host detail. */
function expectClearFailure(evaluation: HostedEvaluation): void {
  expect(evaluation.result.kind, evaluation.expression).toBe('error');
  expect(
    ['limit_exceeded', 'timed_out', 'evaluation_failed'],
    evaluation.expression,
  ).toContain(evaluation.result.code);
  expect(evaluation.result.message, evaluation.expression).toMatch(/\S/u);
  expect(evaluation.result.message, evaluation.expression).not.toMatch(
    /node:internal|\/workspace\/|\/Users\/|\bat .+:\d+:\d+/u,
  );
}

const MEMORY_BOMBS = [
  '$join([1..10000000],",")',
  '$uppercase($pad("x",200000000))',
  '$pad("x",200000000)',
  '$string([1..10000000])',
  '$reverse([1..10000000])',
  '$count([1..10000000])',
  '$sum([1..10000000])',
  '[1..3000].[1..3000]',
  '{"a":[1..10000000]}',
] as const;

// A 900 KB value is within the input limit; the expression multiplies it.
const LARGE_VALUE = 'x'.repeat(900_000);
const MULTIPLIED_INPUT = `$uppercase($join([${Array.from(
  { length: 100 },
  () => 'runInput.s',
).join(',')}]))`;

// Quadratic work on a small list: it spins without building anything large.
const CPU_BOMBS = ['$distinct([1..50000])', '$count($distinct([1..50000]))'];

describe('an expression cannot take down its host process', () => {
  // sec-01: V8 aborts the whole process on one oversized allocation in the thread.
  it.fails(
    'fails over-limit memory with an error and the host keeps working',
    async () => {
      const bombs = MEMORY_BOMBS.flatMap((expression) =>
        Array.from({ length: 3 }, () => ({ expression })),
      );
      const outcome = await evaluateInRealProcess([
        ...bombs,
        { expression: MULTIPLIED_INPUT, runInput: { s: LARGE_VALUE } },
        { expression: '1 + 1' },
      ]);

      expect(survived(outcome)).toBe('survived');
      expect(outcome.evaluations).toHaveLength(bombs.length + 2);
      for (const evaluation of outcome.evaluations.slice(0, -1))
        expectClearFailure(evaluation);
      expect(outcome.evaluations.at(-1)?.result).toMatchObject({
        kind: 'value',
        value: 2,
      });
    },
    120_000,
  );

  // sec-01: the crash takes every other evaluation in the process with it.
  it.fails(
    'keeps serving other evaluations while bombs run beside them',
    async () => {
      const outcome = await evaluateInRealProcess(
        [
          ...MEMORY_BOMBS.map((expression) => ({ expression })),
          ...MEMORY_BOMBS.map((expression) => ({ expression })),
          ...Array.from({ length: 12 }, (_, index) => ({
            expression: `${String(index)} + 1000`,
          })),
        ],
        { concurrently: true },
      );

      expect(survived(outcome)).toBe('survived');
      const answers = outcome.evaluations.filter((item) =>
        item.expression.endsWith('+ 1000'),
      );
      // They finish in whatever order the threads do.
      expect(
        answers
          .map((item) => item.result.value)
          .sort((a, b) => Number(a) - Number(b)),
      ).toEqual(Array.from({ length: 12 }, (_, index) => index + 1000));
    },
    120_000,
  );

  it('fails over-limit time with an error of its own', async () => {
    const outcome = await evaluateInRealProcess(
      CPU_BOMBS.map((expression) => ({ expression })),
    );

    expect(survived(outcome)).toBe('survived');
    expect(outcome.evaluations).toHaveLength(CPU_BOMBS.length);
    for (const evaluation of outcome.evaluations) {
      expect(evaluation.result.code, evaluation.expression).toBe('timed_out');
      expectClearFailure(evaluation);
      // The 100 ms limit plus a thread start, with room for a loaded machine.
      expect(evaluation.elapsedMs, evaluation.expression).toBeLessThan(10_000);
    }
  }, 120_000);
});
