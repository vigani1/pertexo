import type { ValueSource, WorkflowGraph } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';

import { WorkspaceVariableUsageChangedError } from '../../src/variables/contract.js';
import { scanVariableUsage } from '../../src/variables/usage-scan.js';

const WORKFLOW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_WORKFLOW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VERSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NEW_VERSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const direct = (name: string): ValueSource => ({
  kind: 'workspace_variable',
  name,
});
const expression = (source: string): ValueSource => ({
  kind: 'expression',
  language: 'jsonata',
  expression: source,
});
const unrelated = (count: number) =>
  Array.from({ length: count }, () => expression('"unrelated"'));

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

function workflow(
  overrides: Partial<Parameters<typeof scanVariableUsage>[0]> = {},
): Parameters<typeof scanVariableUsage>[0] {
  return {
    id: WORKFLOW,
    name: 'Invoices',
    lifecycleStatus: 'active',
    draftRevision: 3,
    draftGraph: null,
    versionId: null,
    publishedGraph: null,
    hasMore: false,
    ...overrides,
  };
}

const ask = { name: 'RATE', limit: 25 };

function nextOf(page: ReturnType<typeof scanVariableUsage>) {
  if (page.next === null) throw new Error('Expected a continuation');
  return page.next;
}

describe('the source budget', () => {
  it('parses 100 sources in a page and resumes at the next one', () => {
    const scanned = workflow({
      draftGraph: graph(...unrelated(100), direct('RATE')),
    });
    const first = scanVariableUsage(scanned, ask);
    expect(first.items).toEqual([]);
    expect(first.next).toMatchObject({ workflowId: WORKFLOW, offset: 100 });
    const second = scanVariableUsage(scanned, {
      ...ask,
      after: nextOf(first),
    });
    expect(second.items.map((item) => item.input)).toEqual(['input_100']);
    expect(second.next).toBeNull();
  });

  it('needs no second page for exactly 100 sources', () => {
    expect(
      scanVariableUsage(workflow({ draftGraph: graph(...unrelated(100)) }), ask)
        .next,
    ).toBeNull();
  });
});

describe('the byte budget', () => {
  // Quoted, this is the longest expression the policy accepts: 16,384 bytes.
  const longest = expression(`"${'a'.repeat(16_382)}"`);

  it('fits exactly 65,536 bytes in a page and stops one byte over', () => {
    const page = scanVariableUsage(
      workflow({
        draftGraph: graph(longest, longest, longest, longest, expression('1')),
      }),
      ask,
    );
    expect(page.next).toMatchObject({ offset: 4 });
  });

  it('finishes when the sources add up to exactly 65,536 bytes', () => {
    const page = scanVariableUsage(
      workflow({ draftGraph: graph(longest, longest, longest, longest) }),
      ask,
    );
    expect(page.next).toBeNull();
    expect(page.incomplete).toBe(false);
  });

  it('counts an expression over the policy limit as unanalysed and moves past it', () => {
    const page = scanVariableUsage(
      workflow({
        draftGraph: graph(expression('a'.repeat(70_000)), direct('RATE')),
      }),
      ask,
    );
    expect(page.incomplete).toBe(true);
    expect(page.items.map((item) => item.input)).toEqual(['input_001']);
    expect(page.next).toBeNull();
  });
});

describe('the limit', () => {
  const scanned = workflow({
    draftGraph: graph(direct('RATE'), direct('RATE'), direct('RATE')),
  });

  it('cuts the page at the limit and resumes after the last item', () => {
    const first = scanVariableUsage(scanned, { ...ask, limit: 2 });
    expect(first.items.map((item) => item.input)).toEqual([
      'input_000',
      'input_001',
    ]);
    expect(first.next).toMatchObject({ offset: 2 });
    const second = scanVariableUsage(scanned, {
      ...ask,
      limit: 2,
      after: nextOf(first),
    });
    expect(second.items.map((item) => item.input)).toEqual(['input_002']);
    expect(second.next).toBeNull();
  });

  it('asks for no further page when the limit lands on the last source', () => {
    expect(scanVariableUsage(scanned, { ...ask, limit: 3 }).next).toBeNull();
  });
});

describe('resuming from draft to publication', () => {
  const scanned = workflow({
    draftGraph: graph(direct('RATE'), direct('RATE')),
    versionId: VERSION,
    publishedGraph: graph(direct('RATE'), direct('RATE')),
  });
  const seen = (page: ReturnType<typeof scanVariableUsage>) =>
    page.items.map(({ stage, input }) => [stage, input]);

  it('numbers sources across both graphs, so a cursor can land in the publication', () => {
    const first = scanVariableUsage(scanned, { ...ask, limit: 3 });
    expect(seen(first)).toEqual([
      ['draft', 'input_000'],
      ['draft', 'input_001'],
      ['published', 'input_000'],
    ]);
    expect(first.next).toMatchObject({ offset: 3 });
    const second = scanVariableUsage(scanned, {
      ...ask,
      limit: 3,
      after: nextOf(first),
    });
    expect(seen(second)).toEqual([['published', 'input_001']]);
    expect(second.next).toBeNull();
  });

  it('gives a source the same distinct id however the pages were cut', () => {
    const whole = scanVariableUsage(scanned, ask).items.map((item) => item.id);
    const first = scanVariableUsage(scanned, { ...ask, limit: 1 });
    const rest = scanVariableUsage(scanned, { ...ask, after: nextOf(first) });
    expect(new Set(whole).size).toBe(4);
    expect([...first.items, ...rest.items].map((item) => item.id)).toEqual(
      whole,
    );
  });

  it('gives draft sources new ids when the draft moves on', () => {
    const before = scanVariableUsage(scanned, ask).items;
    const after = scanVariableUsage(
      { ...scanned, draftRevision: 4 },
      ask,
    ).items;
    expect(after[0]?.id).not.toBe(before[0]?.id);
    expect(after[2]?.id).toBe(before[2]?.id);
  });
});

describe('a continuation', () => {
  const scanned = workflow({
    draftGraph: graph(direct('RATE'), direct('RATE')),
    versionId: VERSION,
    publishedGraph: graph(direct('RATE')),
  });
  const cursor = () => nextOf(scanVariableUsage(scanned, { ...ask, limit: 1 }));

  it.each([
    ['the draft moved on', { draftRevision: 4 }],
    ['another version was published', { versionId: NEW_VERSION }],
    ['the cursor names another workflow', { id: OTHER_WORKFLOW }],
  ])('is refused when %s', (_case, change) => {
    const after = cursor();
    expect(() =>
      scanVariableUsage({ ...scanned, ...change }, { ...ask, after }),
    ).toThrow(WorkspaceVariableUsageChangedError);
  });

  it('at offset 0 only says where to start, so its stamp and workflow do not matter', () => {
    const page = scanVariableUsage(scanned, {
      ...ask,
      after: { workflowId: OTHER_WORKFLOW, offset: 0, stamp: '0'.repeat(64) },
    });
    expect(page.items).toHaveLength(3);
  });

  it('after a finished workflow points past it while more workflows remain', () => {
    expect(scanVariableUsage({ ...scanned, hasMore: true }, ask).next).toEqual({
      workflowId: WORKFLOW,
      offset: 0,
      stamp: expect.stringMatching(/^[0-9a-f]{64}$/u) as string,
    });
    expect(scanVariableUsage(scanned, ask).next).toBeNull();
  });

  it('passes a workflow with neither a draft nor a publication', () => {
    expect(
      scanVariableUsage(workflow({ draftRevision: null, hasMore: true }), ask),
    ).toEqual({
      items: [],
      incomplete: false,
      next: {
        workflowId: WORKFLOW,
        offset: 0,
        stamp: expect.stringMatching(/^[0-9a-f]{64}$/u) as string,
      },
    });
  });
});

describe('what counts as a reference', () => {
  it('stays incomplete once any source could not be analysed', () => {
    expect(
      scanVariableUsage(
        workflow({
          draftGraph: graph(expression('$vars.('), expression('"valid"')),
        }),
        ask,
      ).incomplete,
    ).toBe(true);
    expect(
      scanVariableUsage(
        workflow({ draftGraph: graph(expression('"valid"')) }),
        ask,
      ).incomplete,
    ).toBe(false);
  });

  it.each([
    [direct('RATE'), 'direct'],
    [expression('$vars.RATE * 2'), 'direct'],
    [expression('$lookup($vars,runInput.name)'), 'dynamic'],
    [expression('$vars'), 'dynamic'],
  ] as const)('reports %j as a %s reference to RATE', (source, kind) => {
    expect(
      scanVariableUsage(workflow({ draftGraph: graph(source) }), ask).items.map(
        (item) => item.kind,
      ),
    ).toEqual([kind]);
  });

  it.each([
    [direct('OTHER')],
    [expression('$vars.OTHER')],
    [expression('"$vars.RATE"')],
    [{ kind: 'literal', value: '$vars.RATE' } as const],
  ])('does not report %j as a reference to RATE', (source) => {
    expect(
      scanVariableUsage(workflow({ draftGraph: graph(source) }), ask).items,
    ).toEqual([]);
  });

  it('matches a dynamic reference whichever name is asked about', () => {
    const scanned = workflow({
      draftGraph: graph(expression('$lookup($vars,runInput.name)')),
    });
    for (const name of ['RATE', 'ANYTHING_ELSE'])
      expect(scanVariableUsage(scanned, { ...ask, name }).items).toHaveLength(
        1,
      );
  });

  it('finds the current publication even without a draft', () => {
    const page = scanVariableUsage(
      workflow({
        draftRevision: null,
        versionId: VERSION,
        publishedGraph: graph(direct('RATE')),
      }),
      ask,
    );
    expect(page.items.map((item) => item.stage)).toEqual(['published']);
  });

  it('finds loop bodies and the callable result', () => {
    const body = graph(direct('RATE'));
    const [step] = graph().nodes;
    if (step === undefined) throw new Error('Expected a step');
    const page = scanVariableUsage(
      workflow({
        draftGraph: {
          settings: {},
          edges: [],
          callable: {
            input: { type: 'object', properties: [] },
            resultType: { type: 'number' },
            result: expression('$vars.RATE'),
          },
          nodes: [
            {
              ...step,
              id: 'loop',
              structured: {
                kind: 'for_each',
                maxIterations: 1,
                maxConcurrency: 1,
                body: {
                  ...body,
                  inputPorts: ['item', 'ordinal'],
                  outputPorts: ['result'],
                },
              },
            },
          ],
        } satisfies WorkflowGraph,
      }),
      ask,
    );
    expect(
      page.items.map(({ nodeId, label, input }) => ({ nodeId, label, input })),
    ).toEqual([
      { nodeId: null, label: 'Workflow result', input: 'result' },
      { nodeId: 'step', label: 'step', input: 'input_000' },
    ]);
  });

  it('describes the workflow and step each item came from', () => {
    const page = scanVariableUsage(
      workflow({
        name: 'n'.repeat(200),
        lifecycleStatus: 'archived',
        draftGraph: graph(direct('RATE')),
      }),
      ask,
    );
    expect(page.items).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f]{64}$/u) as string,
        workflowId: WORKFLOW,
        workflowName: 'n'.repeat(160),
        archived: true,
        stage: 'draft',
        nodeId: 'step',
        label: 'step',
        input: 'input_000',
        kind: 'direct',
      },
    ]);
    expect(
      scanVariableUsage(workflow({ draftGraph: graph(direct('RATE')) }), ask)
        .items[0]?.archived,
    ).toBe(false);
  });
});
