import { describe, it, expect } from 'vitest';
import {
  workflowTestExpectationsSchema,
  testAssertionSchema,
} from '../../src/authoring/test-suites/contract.js';
import {
  matchesTestAssertion,
  observeTestAssertion,
} from '../../src/authoring/test-suites/compare.js';
const assertion = (extra: Record<string, unknown> = {}) =>
  testAssertionSchema.parse({
    source: { kind: 'final' },
    path: '$.total',
    operator: 'equals',
    expected: 12,
    ...extra,
  });
describe('suite expectations', () => {
  it('compares JSON structurally and contains only its documented shapes', () => {
    expect(matchesTestAssertion({ b: 2, a: 1 }, 'equals', { a: 1, b: 2 })).toBe(
      true,
    );
    expect(matchesTestAssertion([1, 2], 'equals', [2, 1])).toBe(false);
    expect(matchesTestAssertion('Hello World', 'contains', 'World')).toBe(true);
    expect(matchesTestAssertion('Hello World', 'contains', 'world')).toBe(
      false,
    );
    expect(
      matchesTestAssertion([{ currency: 'USD' }, false], 'contains', {
        currency: 'USD',
      }),
    ).toBe(true);
    expect(
      matchesTestAssertion({ id: 1, nested: { a: 2 } }, 'contains', {
        nested: { a: 2 },
      }),
    ).toBe(true);
    expect(matchesTestAssertion(12, 'contains', 2)).toBe(false);
    expect(matchesTestAssertion(null, 'contains', null)).toBe(false);
  });
  it('distinguishes null, missing and own-property paths and bounds large displays', () => {
    expect(observeTestAssertion({ total: 12 }, assertion())).toEqual({
      state: 'value',
      matched: true,
      value: 12,
    });
    expect(
      observeTestAssertion({ total: null }, assertion({ expected: null })),
    ).toEqual({ state: 'value', matched: true, value: null });
    expect(observeTestAssertion({}, assertion())).toEqual({
      state: 'missing',
      matched: false,
    });
    expect(
      observeTestAssertion({}, assertion({ path: '$.constructor' })),
    ).toEqual({ state: 'missing', matched: false });
    expect(
      observeTestAssertion(
        { total: '🧵'.repeat(2000) },
        assertion({ operator: 'contains', expected: '🧵' }),
      ),
    ).toMatchObject({
      state: 'value',
      matched: true,
      truncated: true,
      bytes: 8002,
    });
  });
  it('validates bounded safe JSON, paths and aggregate cases without executing accessors', () => {
    expect(workflowTestExpectationsSchema.parse({})).toEqual({
      outcome: 'succeeds',
      assertions: [],
    });
    expect(() => assertion({ path: '$.items[*]' })).toThrow();
    expect(() => assertion({ path: '$[9999999999999999999999]' })).toThrow();
    expect(() => assertion({ expected: 'x'.repeat(4096) })).toThrow();
    expect(() => assertion({ expected: '\0' })).toThrow();
    expect(() => assertion({ expected: '\ud800' })).toThrow();
    expect(assertion({ expected: '🧵' }).expected).toBe('🧵');
    expect(() =>
      assertion({
        expected: Object.defineProperty({}, 'secret', {
          enumerable: true,
          get() {
            throw new Error('Accessor executed');
          },
        }),
      }),
    ).toThrow(/4 KiB/u);
    expect(() =>
      workflowTestExpectationsSchema.parse({
        assertions: [assertion(), assertion()],
      }),
    ).toThrow(/duplicate/u);
    expect(() =>
      workflowTestExpectationsSchema.parse({
        assertions: Array.from({ length: 21 }, () => assertion()),
      }),
    ).toThrow();
    expect(() =>
      workflowTestExpectationsSchema.parse({
        assertions: Array.from({ length: 5 }, () =>
          assertion({ expected: 'x'.repeat(4000) }),
        ),
      }),
    ).toThrow(/16 KiB/u);
  });
});
