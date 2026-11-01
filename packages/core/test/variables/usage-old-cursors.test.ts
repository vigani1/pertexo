import type { ValueSource, WorkflowGraph } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';

import { WorkspaceVariableUsageChangedError } from '../../src/variables/contract.js';
import { scanVariableUsage } from '../../src/variables/usage-scan.js';
import { walkVariableUsage } from '../../src/variables/usage-walk.js';

const WORKFLOW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_WORKFLOW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VERSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ask = { name: 'RATE', limit: 25 };
const reads: ValueSource = { kind: 'workspace_variable', name: 'RATE' };

function graph(...sources: readonly ValueSource[]): WorkflowGraph {
  return {
    settings: {},
    edges: [],
    nodes: [
      {
        id: 'step',
        definition: { key: 'core.set', version: 1 },
        configVersion: 1,
        config: {},
        position: { x: 0, y: 0 },
        inputMappings: Object.fromEntries(
          sources.map((source, index) => [
            `input_${String(index).padStart(3, '0')}`,
            source,
          ]),
        ),
        connectionRefs: {},
      },
    ],
  };
}

describe('a continuation an earlier release issued', () => {
  // Written out, not worked out: a cursor in an open tab outlives a deploy, so
  // these digests must keep meaning draft revision 3 with version VERSION.
  const OLD_STAMP =
    '71e35971fd241b9ab60b2bd8ce2b5886e0aa04bb229c0f68cc9b7180328fde0b';
  const scanned = {
    id: WORKFLOW,
    name: 'Invoices',
    lifecycleStatus: 'active',
    draftRevision: 3,
    draftGraph: graph(reads, reads),
    versionId: VERSION,
    publishedGraph: graph(reads),
    hasMore: false,
  };

  it('resumes inside the workflow it names, at offset above 0', () => {
    const page = scanVariableUsage(scanned, {
      ...ask,
      after: { workflowId: WORKFLOW, offset: 1, stamp: OLD_STAMP },
    });
    expect(page.items.map(({ stage, input }) => [stage, input])).toEqual([
      ['draft', 'input_001'],
      ['published', 'input_000'],
    ]);
    expect(page.next).toBeNull();
  });

  it('is still what this release issues for the same workflow', () => {
    expect(scanVariableUsage(scanned, { ...ask, limit: 1 }).next).toEqual({
      workflowId: WORKFLOW,
      offset: 1,
      stamp: OLD_STAMP,
    });
    expect(scanVariableUsage({ ...scanned, hasMore: true }, ask).next).toEqual({
      workflowId: WORKFLOW,
      offset: 0,
      stamp: OLD_STAMP,
    });
  });

  it('is refused above offset 0 once the workflow has changed', () => {
    expect(() =>
      scanVariableUsage(
        { ...scanned, draftRevision: 4 },
        {
          ...ask,
          after: { workflowId: WORKFLOW, offset: 1, stamp: OLD_STAMP },
        },
      ),
    ).toThrow(WorkspaceVariableUsageChangedError);
  });

  it('passes the workflow it names at offset 0, even if that workflow changed since', async () => {
    const page = await walkVariableUsage(
      {
        ...ask,
        after: { workflowId: WORKFLOW, offset: 0, stamp: OLD_STAMP },
      },
      (after) =>
        Promise.resolve(
          after?.workflowId === WORKFLOW && after.offset === 0
            ? { ...scanned, id: OTHER_WORKFLOW, draftRevision: 9 }
            : scanned,
        ),
    );
    expect(page.items.map((item) => item.workflowId)).toEqual([
      OTHER_WORKFLOW,
      OTHER_WORKFLOW,
      OTHER_WORKFLOW,
    ]);
    expect(page.next).toBeNull();
  });
});
