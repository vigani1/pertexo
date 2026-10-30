import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { evaluateInRealProcess, type HostOutcome } from './survival/host.js';

const RESULT_ERROR_CODES = [
  'invalid_expression',
  'disallowed_construct',
  'limit_exceeded',
  'timed_out',
  'evaluation_failed',
  'variable_missing',
  'callback_unavailable',
];

const BUILTINS = [
  'string',
  'number',
  'boolean',
  'not',
  'exists',
  'type',
  'count',
  'sum',
  'min',
  'max',
  'average',
  'append',
  'reverse',
  'distinct',
  'join',
  'substring',
  'substringBefore',
  'substringAfter',
  'uppercase',
  'lowercase',
  'length',
  'trim',
  'pad',
  'keys',
  'lookup',
  'merge',
  'spread',
];

const TOKENS = [
  ...BUILTINS.map((name) => `$${name}(`),
  'runInput',
  'runInput.a',
  'nodeOutputs',
  '$',
  '$$',
  '$vars',
  '%',
  '*',
  '**',
  '..',
  '.',
  ',',
  ':',
  ';',
  '?',
  '~>',
  ':=',
  '&',
  '+',
  '-',
  '=',
  '!=',
  'in',
  'and',
  'or',
  'function',
  'λ',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '"x"',
  "'",
  '`',
  '/a+/',
  '0',
  '1',
  '1e308',
  '-1',
  'null',
  'true',
  '__proto__',
  'constructor',
];

/** Well-formed programs over every allowed construct, sized by `size`. */
function programs(size: fc.Arbitrary<number>): fc.Arbitrary<string> {
  const { program } = fc.letrec<{ program: string; list: string }>((tie) => ({
    list: fc.oneof(
      size.map((high) => `[1..${String(high)}]`),
      fc
        .array(tie('program'), { minLength: 1, maxLength: 3 })
        .map((items) => `[${items.join(',')}]`),
      fc.constant('runInput.items'),
    ),
    program: fc.oneof(
      { depthSize: 'small' },
      fc.constantFrom('1', '"text"', 'runInput.a', 'runInput', 'null'),
      tie('list'),
      fc
        .tuple(
          fc.constantFrom(...BUILTINS),
          fc.array(tie('program'), { maxLength: 3 }),
        )
        .map(([name, args]) => `$${name}(${args.join(',')})`),
      fc
        .tuple(tie('program'), size)
        .map(([text, length]) => `$pad(${text},${String(length)},"x")`),
      fc
        .tuple(tie('list'), fc.constantFrom('","', '""'))
        .map(([items, separator]) => `$join(${items},${separator})`),
      fc
        .tuple(tie('list'), tie('list'))
        .map(([left, right]) => `${left}.${right}`),
      fc
        .tuple(tie('list'), tie('program'))
        .map(([items, test]) => `${items}[${test}]`),
      fc
        .tuple(
          tie('program'),
          fc.constantFrom('&', '+', '=', 'and'),
          tie('program'),
        )
        .map(([left, operator, right]) => `(${left} ${operator} ${right})`),
      fc
        .tuple(tie('program'), tie('program'), tie('program'))
        .map(([test, yes, no]) => `(${test} ? ${yes} : ${no})`),
      tie('program').map((value) => `{"key":${value}}`),
    ),
  }));
  return program;
}

const nonsense = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc
    .array(fc.constantFrom(...TOKENS), { maxLength: 40 })
    .map((tokens) => tokens.join(' ')),
);

const RUN_INPUT = { a: 'text', items: [1, 2, 3] };

function expectEveryResultTagged(outcome: HostOutcome): void {
  expect(
    {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      unfinished: outcome.unfinished,
    },
    `the host process must outlive every expression\n${outcome.crashOutput}`,
  ).toEqual({ exitCode: 0, signal: null, unfinished: [] });
  for (const { expression, result } of outcome.evaluations) {
    if (result.kind !== 'error') continue;
    expect(RESULT_ERROR_CODES, expression).toContain(result.code);
    expect(result.message, expression).toMatch(/\S/u);
  }
}

describe('expression fuzzing against a real host process', () => {
  it('answers nonsense and small programs with a tagged result', async () => {
    const seed = Date.now();
    const expressions = [
      ...fc.sample(nonsense, { numRuns: 120, seed }),
      ...fc.sample(programs(fc.integer({ min: 0, max: 40 })), {
        numRuns: 80,
        seed,
      }),
      // The parser runs in the host thread itself, not the bounded one.
      '('.repeat(8_000) + '1' + ')'.repeat(8_000),
      '['.repeat(16_000),
      '{"a":'.repeat(3_000),
      '-'.repeat(16_000) + '1',
      '$not('.repeat(3_000),
      `"${'\\'.repeat(16_000)}`,
      'x'.repeat(20_000),
    ];
    const outcome = await evaluateInRealProcess(
      expressions.map((expression) => ({ expression, runInput: RUN_INPUT })),
    );

    expect(outcome.evaluations.length, `seed ${String(seed)}`).toBe(
      expressions.length,
    );
    expectEveryResultTagged(outcome);
  }, 120_000);

  // sec-01: a program that builds something huge aborts the process.
  it.fails(
    'answers programs that try to build something huge with a tagged result',
    async () => {
      const seed = Date.now();
      const expressions = fc.sample(
        programs(fc.constantFrom(10_000_000, 200_000_000, 3_000, 50_000)),
        { numRuns: 120, seed },
      );
      const outcome = await evaluateInRealProcess(
        expressions.map((expression) => ({ expression, runInput: RUN_INPUT })),
      );

      expect(outcome.evaluations.length, `seed ${String(seed)}`).toBe(
        expressions.length,
      );
      expectEveryResultTagged(outcome);
    },
    120_000,
  );
});
