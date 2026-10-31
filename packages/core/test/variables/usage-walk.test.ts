import type { ValueSource } from '@pertexo/workflow-model';
import { expect, it } from 'vitest';

import { walkVariableUsage } from '../../src/variables/usage-walk.js';

const reads: ValueSource = { kind: 'workspace_variable', name: 'RATE' };
const unrelated: ValueSource = {
  kind: 'expression',
  language: 'jsonata',
  expression: '"unrelated"',
};

const idOf = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

/** Workflows in id order, each holding the given sources in its draft. */
function workspace(...sources: readonly (readonly ValueSource[])[]) {
  const workflows = sources.map((list, index) => ({
    id: idOf(index),
    name: `Workflow ${String(index)}`,
    lifecycleStatus: 'active',
    draftRevision: 1,
    draftGraph: {
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
            list.map((source, at) => [
              `input_${String(at).padStart(3, '0')}`,
              source,
            ]),
          ),
          connectionRefs: {},
        },
      ],
    },
    versionId: null,
    publishedGraph: null,
    hasMore: index < sources.length - 1,
  }));
  return (after: Parameters<Parameters<typeof walkVariableUsage>[1]>[0]) =>
    Promise.resolve(
      workflows.find((workflow) => {
        if (after === undefined) return true;
        return after.offset > 0
          ? workflow.id >= after.workflowId
          : workflow.id > after.workflowId;
      }),
    );
}

const many = (count: number, source = unrelated) =>
  Array.from({ length: count }, () => source);
const ask = { name: 'RATE', limit: 25 };

it('carries on through workflows with no references, up to 25 in a page', async () => {
  const read = workspace(...Array.from({ length: 26 }, () => []));
  const first = await walkVariableUsage(ask, read);
  expect(first.next).toMatchObject({ workflowId: idOf(24), offset: 0 });
  const second = await walkVariableUsage(
    { ...ask, ...(first.next === null ? {} : { after: first.next }) },
    read,
  );
  expect(second.next).toBeNull();
});

it('spends one source budget across workflows, then resumes inside the one it stopped in', async () => {
  const read = workspace(many(60), [...many(50), reads]);
  const first = await walkVariableUsage(ask, read);
  expect(first.items).toEqual([]);
  expect(first.next).toMatchObject({ workflowId: idOf(1), offset: 40 });
  const second = await walkVariableUsage(
    { ...ask, ...(first.next === null ? {} : { after: first.next }) },
    read,
  );
  expect(second.items.map((item) => [item.workflowId, item.input])).toEqual([
    [idOf(1), 'input_050'],
  ]);
  expect(second.next).toBeNull();
});

it('resumes at the next workflow when the budget ran out exactly at the end of one', async () => {
  const read = workspace(many(100), [reads]);
  const first = await walkVariableUsage(ask, read);
  expect(first.next).toMatchObject({ workflowId: idOf(0), offset: 0 });
  const second = await walkVariableUsage(
    { ...ask, ...(first.next === null ? {} : { after: first.next }) },
    read,
  );
  expect(second.items.map((item) => item.workflowId)).toEqual([idOf(1)]);
  expect(second.next).toBeNull();
});

it('counts the item limit across workflows, without skipping or repeating one', async () => {
  const read = workspace([reads], [reads], [reads]);
  const seen: string[] = [];
  let after: Awaited<ReturnType<typeof walkVariableUsage>>['next'] = null;
  for (let page = 0; page < 6; page += 1) {
    const current: Awaited<ReturnType<typeof walkVariableUsage>> =
      await walkVariableUsage(
        { ...ask, limit: 2, ...(after === null ? {} : { after }) },
        read,
      );
    expect(current.items.length).toBeLessThanOrEqual(2);
    seen.push(...current.items.map((item) => item.workflowId));
    after = current.next;
    if (after === null) break;
  }
  expect(after).toBeNull();
  expect(seen).toEqual([idOf(0), idOf(1), idOf(2)]);
});

it('stays incomplete when any workflow in the page could not be analysed', async () => {
  const invalid: ValueSource = { ...unrelated, expression: '$vars.(' } as const;
  const page = await walkVariableUsage(ask, workspace([invalid], [unrelated]));
  expect(page.incomplete).toBe(true);
  expect(page.next).toBeNull();
});

it('finishes with nothing to report when there are no workflows', async () => {
  expect(await walkVariableUsage(ask, workspace())).toEqual({
    items: [],
    incomplete: false,
    next: null,
  });
});
