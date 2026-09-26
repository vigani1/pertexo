import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  addSwitchCase,
  addValidateRule,
  parseRuleEnum,
  readParallelBranches,
  readSwitchCases,
  readValidateRules,
  validatePathProblem,
  withParallelBranchCount,
  withRuleType,
} from '@/features/workflow-editor/model/setup-builders';
import { startingConfig } from '@/features/workflow-editor/model/starting-config';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  editorHandlers,
  editorPath,
  findCanvas,
  pressSave,
  setDefinition,
} from '../support/workflow-editor-fixtures';

type WorkflowNode = WorkflowGraphContract['nodes'][number];

describe('setup lists', () => {
  it('reads Switch cases it can show and adds each on the lowest free output', () => {
    expect(readSwitchCases({})).toEqual([]);
    expect(readSwitchCases({ cases: [{ id: 'case-02', equals: 3 }] })).toEqual([
      { id: 'case-02', equals: 3 },
    ]);
    // Anything the builder would lose stays on JSON.
    expect(readSwitchCases({ cases: 'x' })).toBeUndefined();
    expect(
      readSwitchCases({ cases: [{ id: 'case-99', equals: 1 }] }),
    ).toBeUndefined();
    expect(
      readSwitchCases({ cases: [{ id: 'case-01', equals: { a: 1 } }] }),
    ).toBeUndefined();
    expect(addSwitchCase([{ id: 'case-02', equals: 'a' }])).toEqual([
      { id: 'case-02', equals: 'a' },
      { id: 'case-01', equals: '' },
    ]);
  });

  it('grows and shrinks Parallel branches from the top, keeping branches at once in range', () => {
    const config = {
      branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
      maxConcurrency: 2,
    };
    const three = withParallelBranchCount(
      config,
      readParallelBranches(config) ?? [],
      3,
    );
    expect(three).toEqual({
      branches: [{ id: 'branch-01' }, { id: 'branch-02' }, { id: 'branch-03' }],
      maxConcurrency: 2,
    });
    expect(
      withParallelBranchCount(three, readParallelBranches(three) ?? [], 1),
    ).toEqual({ branches: [{ id: 'branch-01' }], maxConcurrency: 1 });
    // An old step with nothing set starts with every branch at once.
    expect(withParallelBranchCount({}, [], 2)).toEqual({
      branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
      maxConcurrency: 2,
    });
  });

  it('keeps Validate rules exact, with only the bounds a type allows', () => {
    const [rule] = addValidateRule([]);
    expect(rule).toEqual({ id: 'rule-1', path: '$.', required: true });
    const text = withRuleType(
      { id: 'r', path: '$.a', required: false, minimum: 1, maxItems: 2 },
      'string',
    );
    expect(text).toEqual({
      id: 'r',
      path: '$.a',
      required: false,
      type: 'string',
    });
    expect(
      readValidateRules({ rules: [{ id: 'r', path: '$.a', regex: 'x' }] }),
    ).toBeUndefined();
    expect(validatePathProblem('$.email')).toBeUndefined();
    expect(validatePathProblem('email[')).toMatch(/like \$\.email/u);
    expect(parseRuleEnum('draft, sent', 'string')).toEqual({
      ok: true,
      value: ['draft', 'sent'],
    });
    expect(parseRuleEnum('1, 2', 'number')).toEqual({
      ok: true,
      value: [1, 2],
    });
    expect(parseRuleEnum('1, one', 'number').ok).toBe(false);
    expect(parseRuleEnum('a, a', undefined).ok).toBe(false);
    expect(parseRuleEnum('  ', 'string')).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it('starts new steps with a setup that’s ready where it can be', () => {
    const parallel = {
      id: 'p1',
      definition: { key: 'core.parallel', version: 3 },
    } as WorkflowNode;
    expect(startingConfig('core.parallel', [])).toEqual({
      branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
      maxConcurrency: 2,
    });
    expect(startingConfig('core.merge', [parallel])).toEqual({
      policy: { kind: 'all' },
      parallelNodeId: 'p1',
    });
    // Two Parallels: which one to join is the person's choice.
    expect(
      startingConfig('core.merge', [parallel, { ...parallel, id: 'p2' }]),
    ).toEqual({ policy: { kind: 'all' } });
    expect(startingConfig('core.set', [])).toEqual({});
    // Each step gets its own copy.
    const first = startingConfig('core.switch', []);
    expect(startingConfig('core.switch', [])).not.toBe(first);
  });
});

const switchDefinition = {
  ...setDefinition,
  definition: { key: 'core.switch', version: 1 },
  family: 'logic',
  configSchema: {
    type: 'object',
    properties: { cases: { type: 'array' } },
    required: ['cases'],
  },
  ports: {
    inputs: ['in'],
    outputs: ['case-01', 'case-02', 'case-03', 'default'],
  },
} satisfies NodeDefinitionCatalogItem;

function switchGraph(): WorkflowGraphContract {
  const step = (id: string, label: string, key: string, x: number) => ({
    id,
    label,
    definition: { key, version: 1 },
    position: { x, y: 80 },
    configVersion: 1,
    config:
      key === 'core.switch'
        ? { cases: [{ id: 'case-01', equals: 'approved' }] }
        : {},
    inputMappings: {},
    connectionRefs: {},
  });
  return {
    schemaVersion: 1,
    nodes: [
      step('route', 'Route', 'core.switch', 80),
      step('ship', 'Ship', 'core.set', 400),
    ],
    edges: [
      {
        id: 'route-ship',
        source: { nodeId: 'route', port: 'case-01' },
        target: { nodeId: 'ship', port: 'in' },
      },
    ],
    settings: {},
  };
}

describe('Switch cases in Setup', { timeout: 30_000 }, () => {
  it('adds a case, applies its value and keeps a connected case', async () => {
    let saved: WorkflowGraphContract | undefined;
    mockServer.use(
      ...editorHandlers(
        (_request, body) => {
          saved = body.graph;
        },
        {
          graph: switchGraph(),
          definitions: [switchDefinition, setDefinition],
        },
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Route'));
    const cases = screen.getByRole('group', { name: 'Cases' });
    // Case 1 feeds Ship on the canvas, so it stays until disconnected.
    expect(
      within(cases).getByRole('button', { name: 'Remove case 1' }),
    ).toBeDisabled();

    await event.click(within(cases).getByRole('button', { name: 'Add case' }));
    const [, second] = within(cases).getAllByLabelText('Equals');
    if (second === undefined) throw new Error('The new case has no value box.');
    await event.type(second, 'rejected');
    expect(
      within(cases).getByRole('button', { name: 'Remove case 2' }),
    ).toBeEnabled();
    pressSave();
    await waitFor(() => {
      expect(saved?.nodes[0]?.config).toEqual({
        cases: [
          { id: 'case-01', equals: 'approved' },
          { id: 'case-02', equals: 'rejected' },
        ],
      });
    });
  });
});
