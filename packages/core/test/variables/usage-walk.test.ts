import type { ValueSource } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';

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
// Quoted, this is the longest expression the policy accepts: 16,384 bytes, and
// four of them fill a page's 65,536.
const longest: ValueSource = {
  ...unrelated,
  expression: `"${'a'.repeat(16_382)}"`,
} as const;

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

it('spends one byte budget across workflows, then resumes inside the one it stopped in', async () => {
  const read = workspace(many(3, longest), [longest, longest, reads]);
  const first = await walkVariableUsage(ask, read);
  expect(first.items).toEqual([]);
  expect(first.next).toMatchObject({ workflowId: idOf(1), offset: 1 });
  const second = await walkVariableUsage(
    { ...ask, ...(first.next === null ? {} : { after: first.next }) },
    read,
  );
  expect(second.items.map((item) => [item.workflowId, item.input])).toEqual([
    [idOf(1), 'input_002'],
  ]);
  expect(second.next).toBeNull();
});

it('neither skips nor repeats a workflow the byte budget stopped before', async () => {
  const read = workspace(many(4, longest), [reads]);
  const first = await walkVariableUsage(ask, read);
  expect(first.items).toEqual([]);
  expect(first.next).toMatchObject({ workflowId: idOf(0), offset: 0 });
  const second = await walkVariableUsage(
    { ...ask, ...(first.next === null ? {} : { after: first.next }) },
    read,
  );
  expect(second.items.map((item) => item.workflowId)).toEqual([idOf(1)]);
  expect(second.next).toBeNull();
});

it('keeps only one workflow in hand, asking for the next once the last is done', async () => {
  const read = workspace([reads], [reads], [reads]);
  let reading = 0;
  let mostAtOnce = 0;
  await walkVariableUsage(ask, async (after) => {
    reading += 1;
    mostAtOnce = Math.max(mostAtOnce, reading);
    await new Promise((resolve) => setImmediate(resolve));
    reading -= 1;
    return read(after);
  });
  expect(mostAtOnce).toBe(1);
});

it('asks for no more than 25 workflows in a page, however few of them have sources', async () => {
  const read = workspace(...Array.from({ length: 80 }, () => []));
  let asked = 0;
  await walkVariableUsage(ask, (after) => {
    asked += 1;
    return read(after);
  });
  expect(asked).toBe(25);
});

describe('any workspace, cut any way', () => {
  /** Repeatable, so a failure names a workspace rather than a passing fluke. */
  function randomFrom(seed: number) {
    let state = seed;
    return (below: number) => {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return Math.floor((state / 4_294_967_296) * below);
    };
  }

  function randomWorkspace(seed: number) {
    const random = randomFrom(seed);
    return Array.from({ length: 1 + random(20) }, () => {
      const shape = random(4);
      if (shape === 0) return [];
      return Array.from({ length: 1 + random(shape === 3 ? 130 : 6) }, () => {
        const kind = random(8);
        if (kind === 0) return longest;
        return kind < 3 ? reads : unrelated;
      });
    });
  }

  it.each([1, 2, 25, 100])(
    'finds every reference once and in order, within each page’s limits, at a limit of %i',
    async (limit) => {
      for (let seed = 1; seed <= 8; seed += 1) {
        const sources = randomWorkspace(seed);
        const read = workspace(...sources);
        const expected = sources.flatMap((list, index) =>
          list.flatMap((source, at) =>
            source === reads
              ? [`${idOf(index)} input_${String(at).padStart(3, '0')}`]
              : [],
          ),
        );
        const seen: string[] = [];
        let after: Awaited<ReturnType<typeof walkVariableUsage>>['next'] = null;
        let pages = 0;
        do {
          let asked = 0;
          const page: Awaited<ReturnType<typeof walkVariableUsage>> =
            await walkVariableUsage(
              { ...ask, limit, ...(after === null ? {} : { after }) },
              (cursor) => {
                asked += 1;
                return read(cursor);
              },
            );
          expect(page.items.length).toBeLessThanOrEqual(limit);
          expect(asked).toBeLessThanOrEqual(25);
          seen.push(
            ...page.items.map((item) => `${item.workflowId} ${item.input}`),
          );
          after = page.next;
          pages += 1;
          // Every page moves on, so a stuck cursor fails rather than hangs.
          expect(pages).toBeLessThan(2_000);
        } while (after !== null);
        expect(seen).toEqual(expected);
      }
    },
    60_000,
  );
});
