import { describe, expect, it } from 'vitest';
import {
  evaluateSuiteExpectations,
  type SuiteOutput,
} from '../../src/testing/evaluate-suite.js';
import type { WorkflowTestExpectations } from '@pertexo/workflow-model';

const assertions: WorkflowTestExpectations['assertions'] = [
  {
    source: { kind: 'final' },
    path: '$.answer',
    operator: 'equals',
    expected: 42,
  },
];
describe('suite expectation evaluation', () => {
  it.each(['succeeds', 'fails'] as const)(
    'matches an expected %s outcome',
    (outcome) => {
      const result = evaluateSuiteExpectations(
        { outcome, assertions: [] },
        {
          status: outcome === 'succeeds' ? 'succeeded' : 'failed',
          pinRequired: false,
        },
        new Map(),
      );
      expect(result).toMatchObject({
        status: 'passed',
        report: { outcomeMatched: true },
      });
    },
  );
  it('fails an outcome mismatch even when all value assertions pass', () => {
    expect(
      evaluateSuiteExpectations(
        { outcome: 'fails', assertions },
        { status: 'succeeded', pinRequired: false },
        new Map([['final', { state: 'value', value: { answer: 42 } }]]),
      ),
    ).toMatchObject({
      status: 'failed',
      report: {
        outcomeMatched: false,
        assertions: [{ actual: { matched: true } }],
      },
    });
  });
  it.each(['unavailable', 'ambiguous'] as const)(
    'fails a %s output without guessing its value',
    (state) => {
      expect(
        evaluateSuiteExpectations(
          { outcome: 'succeeds', assertions },
          { status: 'succeeded', pinRequired: false },
          new Map<string, SuiteOutput>([['final', { state }]]),
        ),
      ).toMatchObject({
        status: 'failed',
        report: { assertions: [{ actual: { state, matched: false } }] },
      });
    },
  );
  it('observes a missing JSON path separately from unavailable output', () => {
    expect(
      evaluateSuiteExpectations(
        { outcome: 'succeeds', assertions },
        { status: 'succeeded', pinRequired: false },
        new Map([['final', { state: 'value', value: {} }]]),
      ),
    ).toMatchObject({
      status: 'failed',
      report: {
        assertions: [{ actual: { state: 'missing', matched: false } }],
      },
    });
  });
  it.each([
    ['timed_out', 'run_timed_out'],
    ['outcome_unknown', 'run_outcome_unknown'],
    ['canceled', 'run_canceled'],
  ] as const)(
    'reports %s as an error even when failure is expected',
    (status, error) => {
      expect(
        evaluateSuiteExpectations(
          { outcome: 'fails', assertions: [] },
          { status, pinRequired: false },
          new Map(),
        ),
      ).toMatchObject({ status: 'error', report: { error } });
    },
  );
  it('prioritizes missing required pins over a timeout', () => {
    expect(
      evaluateSuiteExpectations(
        { outcome: 'fails', assertions: [] },
        { status: 'timed_out', pinRequired: true },
        new Map(),
      ),
    ).toMatchObject({
      status: 'error',
      report: { error: 'test_pin_required' },
    });
  });
  it('uses a selected step output for step assertions', () => {
    expect(
      evaluateSuiteExpectations(
        {
          outcome: 'succeeds',
          assertions: [
            {
              path: '$.answer',
              operator: 'equals',
              expected: 42,
              source: { kind: 'step', nodeId: 'answer' },
            },
          ],
        },
        { status: 'succeeded', pinRequired: false },
        new Map([['step:answer', { state: 'value', value: { answer: 42 } }]]),
      ),
    ).toMatchObject({ status: 'passed' });
  });
});
