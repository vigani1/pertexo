import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { evaluateSuiteCase } from '../../../src/previews/suites/evaluate.queries.js';
import type { SuiteCaseRow } from '../../../src/previews/suites/contract.js';
const entry: SuiteCaseRow = {
  workspace_id: randomUUID(),
  suite_id: randomUUID(),
  ordinal: 0,
  case_id: randomUUID(),
  case_revision: 1,
  name: 'Output checks',
  input: '{}',
  expectations: JSON.stringify({
    outcome: 'succeeds',
    assertions: [
      {
        source: { kind: 'step', nodeId: 'file' },
        path: '$',
        operator: 'equals',
        expected: null,
      },
      {
        source: { kind: 'step', nodeId: 'file' },
        path: '$.data',
        operator: 'contains',
        expected: 'value',
      },
    ],
  }),
  run_id: randomUUID(),
  status: 'running',
  report: null,
};
describe('suite output observations', () => {
  it('does not download a file-backed value and shares one selected output read across assertions', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          status: 'succeeded',
          output_ref: { kind: 'artifact', artifactId: randomUUID() },
        },
      ],
    });
    const result = await evaluateSuiteCase(
      { query } as unknown as PoolClient,
      entry,
      { status: 'succeeded', output_ref: null, pin_required: false },
    );
    expect(result.status).toBe('failed');
    expect(result.report.assertions.map((item) => item.actual)).toEqual([
      { state: 'unavailable', matched: false },
      { state: 'unavailable', matched: false },
    ]);
    expect(query).toHaveBeenCalledOnce();
  });
  it('never treats a missing control-step pin as an expected failure or handled success', async () => {
    const client = { query: vi.fn() } as unknown as PoolClient;
    for (const status of ['failed', 'succeeded'] as const) {
      const result = await evaluateSuiteCase(
        client,
        {
          ...entry,
          expectations: JSON.stringify({ outcome: 'fails', assertions: [] }),
        },
        { status, output_ref: null, pin_required: true },
      );
      expect(result).toMatchObject({
        status: 'error',
        report: { error: 'test_pin_required' },
      });
    }
  });
  it('returns a dense actual array within the envelope without truncation or an incompatible response bound', async () => {
    const value = Array.from({ length: 1500 }, () => 0);
    const result = await evaluateSuiteCase(
      { query: vi.fn() } as unknown as PoolClient,
      {
        ...entry,
        expectations: JSON.stringify({
          outcome: 'succeeds',
          assertions: [
            {
              source: { kind: 'final' },
              path: '$',
              operator: 'contains',
              expected: 0,
            },
          ],
        }),
      },
      {
        status: 'succeeded',
        output_ref: { kind: 'inline', value },
        pin_required: false,
      },
    );
    expect(result).toMatchObject({
      status: 'passed',
      report: {
        assertions: [{ actual: { state: 'value', matched: true, value } }],
      },
    });
  });
});
