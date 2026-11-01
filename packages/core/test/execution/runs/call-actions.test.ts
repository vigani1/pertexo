import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import { describe, expect, it, vi } from 'vitest';
import { advanceRun } from '../../../src/execution/runs/advance.js';
import {
  RUN_ID,
  VERSION_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  graph,
} from '../support/workflow.fixture.js';

const input = () => ({
  runId: RUN_ID,
  workspaceId: WORKSPACE_ID,
  signal: new AbortController().signal,
  delivery: {
    outboxEventId: '55555555-5555-4555-8555-555555555555',
    payloadChecksum: 'a'.repeat(64),
  },
});
const projection = (callable: boolean) => {
  const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);
  const executable = buildWorkflowExecutable({
    catalog,
    graph: {
      ...graph(),
      ...(callable
        ? {
            callable: {
              input: { type: 'string' as const },
              resultType: { type: 'string' as const },
              result: { kind: 'run_input' as const, path: '$' },
            },
          }
        : {}),
    },
  });
  return {
    catalog,
    published: {
      id: VERSION_ID,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      versionNumber: 1,
      checksum: executable.checksum,
      executableJson: executable.envelope,
    },
  };
};

describe('Call actions before ordinary advance', () => {
  it('prepares the exact typed child once before opening the parent transaction', async () => {
    const child = projection(true);
    const order: string[] = [];
    await advanceRun(
      {
        maximumAdmissions: 1,
        now: () => '2026-10-11T02:00:00.000Z',
        verification: { catalog: child.catalog },
        calls: {
          close: () => Promise.resolve(),
          performActions: (_input, prepare) => {
            order.push('actions');
            const accepted = prepare(child.published);
            expect(accepted.validateInput).toBeTypeOf('function');
            expect(() =>
              accepted.validateInput?.('typed input', 40),
            ).not.toThrow();
            expect(() => accepted.validateInput?.(1, 25)).toThrow();
            return Promise.resolve();
          },
        },
        runs: {
          close: () => Promise.resolve(),
          advance: () => {
            order.push('advance');
            return Promise.resolve({ kind: 'no_change', revision: 0 });
          },
        },
      },
      input(),
    );
    expect(order).toEqual(['actions', 'advance']);
  });

  it('refuses an ordinary non-callable target before parent advancement', async () => {
    const child = projection(false);
    const advance = vi.fn(() =>
      Promise.resolve({ kind: 'no_change' as const, revision: 0 }),
    );
    await expect(
      advanceRun(
        {
          maximumAdmissions: 1,
          now: () => '2026-10-11T02:00:00.000Z',
          verification: { catalog: child.catalog },
          calls: {
            close: () => Promise.resolve(),
            performActions: (_input, prepare) => {
              prepare(child.published);
              return Promise.resolve();
            },
          },
          runs: { close: () => Promise.resolve(), advance },
        },
        input(),
      ),
    ).rejects.toMatchObject({ code: 'call_target_not_callable' });
    expect(advance).not.toHaveBeenCalled();
  });
});
