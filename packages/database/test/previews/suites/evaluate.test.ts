import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { SuiteCaseRow } from '../../../src/previews/suites/contract.js';
import { evaluateSuiteCase } from '../../../src/previews/suites/evaluate.queries.js';
const entry: SuiteCaseRow = {
  workspaceId: randomUUID(),
  suiteId: randomUUID(),
  ordinal: 0,
  caseId: randomUUID(),
  caseRevision: 1,
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
  runId: randomUUID(),
  status: 'running',
  report: null,
};
describe('suite output observations', () => {
  it('rejects corrupt frozen expectations before reading outputs', async () => {
    const query = vi.fn();
    await expect(
      evaluateSuiteCase(
        { query } as unknown as PoolClient,
        { ...entry, expectations: '{"outcome":"unknown"}' },
        { status: 'succeeded', outputRef: null, pinRequired: false },
      ),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('does not download a file-backed value and shares one selected output read across assertions', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [['succeeded', { kind: 'artifact', artifactId: randomUUID() }]],
    });
    const result = await evaluateSuiteCase(
      { query } as unknown as PoolClient,
      entry,
      { status: 'succeeded', outputRef: null, pinRequired: false },
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
        { status, outputRef: null, pinRequired: true },
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
        outputRef: { kind: 'inline', value },
        pinRequired: false,
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
