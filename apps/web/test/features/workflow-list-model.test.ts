import { describe, expect, it } from 'vitest';
import type {
  WorkflowGraphContract,
  WorkflowSummary,
} from '@pertexo/contracts/schemas/workflow-authoring';
import {
  groupRecentRuns,
  summarizeRunTicks,
} from '@/features/workflows/model/run-strip';
import {
  countWorkflowStates,
  countWorkflowViews,
  filterWorkflows,
  parseWorkflowListSearch,
  updateWorkflowListSearch,
} from '@/features/workflows/model/workflow-list-view';
import {
  describeWorkflowPath,
  definitionName,
  layoutPatternGlyph,
  workflowTriggerKinds,
} from '@/features/workflows/model/workflow-shape';
import {
  availableStarters,
  buildStarterGraph,
} from '@/features/workflows/model/workflow-starters';
import {
  catalogDefinition,
  catalogOf,
  graphOf,
  summary,
} from './workflow-list.fixtures';

function graph(value: WorkflowGraphContract): WorkflowGraphContract {
  return value;
}

function branching(parallel = false): WorkflowGraphContract {
  const base = graphOf([
    { id: 'hook', key: 'core.webhook', x: 0 },
    { id: 'split', key: parallel ? 'core.parallel' : 'core.condition', x: 280 },
  ]);
  const node = (id: string, label: string, y: number) => ({
    id,
    definition: { key: 'http.request', version: 1 },
    position: { x: 560, y },
    configVersion: 1,
    config: {},
    inputMappings: {},
    connectionRefs: {},
    label,
  });
  return graph({
    ...base,
    nodes: [
      ...base.nodes,
      node('a', 'Approve', 0),
      node('b', 'Post to ERP', 200),
    ],
    edges: [
      ...base.edges,
      {
        id: 'e-a',
        source: { nodeId: 'split', port: 'out' },
        target: { nodeId: 'a', port: 'in' },
      },
      {
        id: 'e-b',
        source: { nodeId: 'split', port: 'out' },
        target: { nodeId: 'b', port: 'in' },
      },
    ],
  });
}

describe('workflow shape', () => {
  it('reads the main path from the trigger in plain step names', () => {
    const linear = graph(
      graphOf([
        { id: 'a', key: 'core.webhook', x: 0 },
        { id: 'b', key: 'http.request', label: 'Call CRM', x: 280 },
        { id: 'c', key: 'slack.send_message', x: 560 },
      ]),
    );
    expect(describeWorkflowPath(linear)).toBe(
      'Webhook → Call CRM → Send Slack message',
    );
    expect(describeWorkflowPath(branching())).toBe(
      'Webhook → Condition → Approve or Post to ERP',
    );
    expect(describeWorkflowPath(branching(true))).toBe(
      'Webhook → Parallel → Approve and Post to ERP',
    );
    expect(describeWorkflowPath(graph(graphOf([])))).toBe('No steps yet');
    const long = graph(
      graphOf(
        [
          'core.manual',
          'core.set',
          'core.validate',
          'core.wait',
          'core.set',
        ].map((key, index) => ({
          id: `n${String(index)}`,
          key,
          x: index * 280,
        })),
      ),
    );
    expect(describeWorkflowPath(long)).toBe(
      'Manual start → Set fields → Validate → Wait → …',
    );
  });

  it('names unknown definitions from their key and finds trigger kinds', () => {
    expect(definitionName('acme.create_invoice')).toBe('Create invoice');
    expect(
      workflowTriggerKinds(
        graph(
          graphOf([
            { id: 's', key: 'core.schedule', x: 0 },
            { id: 'h', key: 'core.webhook', x: 0 },
            { id: 'x', key: 'http.request', x: 280 },
          ]),
        ),
      ),
    ).toEqual(['webhook', 'schedule']);
  });

  it('lays steps out in longest-path columns with the trigger marked', () => {
    const layout = layoutPatternGlyph(branching());
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    expect(byId.get('hook')).toMatchObject({ x: 5, y: 14, trigger: true });
    expect(byId.get('split')?.x).toBe(31);
    expect(byId.get('a')).toMatchObject({ x: 57, y: 7, trigger: false });
    expect(byId.get('b')).toMatchObject({ x: 57, y: 21 });
    expect(layout.edges).toHaveLength(3);
    expect(layout.radius).toBe(2.4);
  });

  it('always finishes laying out a draft with a cycle', () => {
    const cyclic = graph({
      ...graphOf([
        { id: 'a', key: 'core.set', x: 0 },
        { id: 'b', key: 'core.set', x: 280 },
      ]),
      edges: [
        {
          id: 'ab',
          source: { nodeId: 'a', port: 'out' },
          target: { nodeId: 'b', port: 'in' },
        },
        {
          id: 'ba',
          source: { nodeId: 'b', port: 'out' },
          target: { nodeId: 'a', port: 'in' },
        },
      ],
    });
    const layout = layoutPatternGlyph(cyclic);
    expect(layout.nodes).toHaveLength(2);
    expect(describeWorkflowPath(cyclic)).toBe('Set fields → Set fields');
  });
});

describe('workflow list view', () => {
  const items = [
    summary('1', 'Daily intake', {
      activationStatus: 'active',
      publishedVersionId: '9',
    }),
    summary('2', 'Old report', { lifecycleStatus: 'archived' }),
    summary('3', 'Incident response'),
    summary('4', 'Incident drill'),
  ] as WorkflowSummary[];

  it('filters loaded workflows by view and a case-insensitive name', () => {
    expect(filterWorkflows(items, { view: 'active', query: '' })).toHaveLength(
      3,
    );
    expect(
      filterWorkflows(items, { view: 'archived', query: '' }).map(
        (w) => w.name,
      ),
    ).toEqual(['Old report']);
    expect(
      filterWorkflows(items, { view: 'all', query: '  incident ' }).map(
        (w) => w.name,
      ),
    ).toEqual(['Incident response', 'Incident drill']);
    expect(countWorkflowViews(items)).toEqual({
      active: 3,
      archived: 1,
      all: 4,
    });
  });

  it('counts non-archived workflows by state in a fixed order', () => {
    expect(countWorkflowStates(items)).toEqual([
      { label: 'live', tone: 'success', count: 1 },
      { label: 'drafts', tone: 'neutral', count: 2 },
    ]);
  });

  it('parses list URL state tolerantly and omits defaults when updating', () => {
    expect(
      parseWorkflowListSearch({ create: 'true', view: 'all', sort: 'created' }),
    ).toEqual({ create: true, view: 'all', sort: 'created' });
    expect(
      parseWorkflowListSearch({ create: 'nope', view: 'active', sort: 'x' }),
    ).toEqual({});
    expect(parseWorkflowListSearch(null)).toEqual({});
    expect(
      updateWorkflowListSearch({ view: 'archived' }, { create: true }),
    ).toEqual({ create: true, view: 'archived' });
    expect(
      updateWorkflowListSearch(
        { create: true, view: 'archived', sort: 'created' },
        { create: false, view: 'active', sort: 'updated' },
      ),
    ).toEqual({});
  });
});

describe('starter patterns', () => {
  it('offers a starter only when every step is available and publishable', () => {
    const catalog = catalogOf([
      catalogDefinition('core.webhook', 'trigger'),
      catalogDefinition('http.request', 'action'),
      catalogDefinition('http.request', 'action', { version: 3 }),
      catalogDefinition('slack.send_message', 'action'),
      catalogDefinition('core.schedule', 'trigger'),
      catalogDefinition('core.validate', 'transform', { publishable: false }),
      catalogDefinition('email.send_notification', 'action'),
    ]);
    const starters = availableStarters(catalog);
    expect(starters.map((starter) => starter.id)).toEqual([
      'webhook-http-slack',
      'schedule-http',
    ]);
    expect(
      starters[0]?.definitions.map((item) => item.definition.version),
    ).toEqual([1, 3, 1]);
  });

  it('builds an unconfigured, connected draft from the chosen definitions', () => {
    const [starter] = availableStarters(
      catalogOf([
        catalogDefinition('core.schedule', 'trigger', { version: 3 }),
        catalogDefinition('http.request', 'action'),
      ]),
    );
    if (starter === undefined) throw new Error('Expected a starter');
    let id = 0;
    const built = buildStarterGraph(starter, () => {
      id += 1;
      return `id-${String(id)}`;
    });
    expect(built.nodes.map((node) => [node.definition, node.label])).toEqual([
      [{ key: 'core.schedule', version: 3 }, 'Schedule'],
      [{ key: 'http.request', version: 1 }, 'Call API'],
    ]);
    expect(built.nodes[0]?.configVersion).toBe(3);
    expect(built.edges).toEqual([
      {
        id: 'id-3',
        source: { nodeId: 'id-1', port: 'out' },
        target: { nodeId: 'id-2', port: 'in' },
      },
    ]);
  });
});

describe('run strips', () => {
  const run = (workflowId: string, status: string, second: number) =>
    ({
      workflowId,
      status,
      createdAt: `2026-09-14T10:00:${String(second).padStart(2, '0')}.000Z`,
    }) as Parameters<typeof groupRecentRuns>[0][number];

  it('groups the latest runs per workflow, oldest to newest, capped at 20', () => {
    const runs = [
      run('a', 'failed', 3),
      run('a', 'succeeded', 1),
      run('b', 'running', 2),
      ...Array.from({ length: 25 }, (_, index) =>
        run('c', 'succeeded', 30 + index),
      ),
    ];
    const grouped = groupRecentRuns(runs);
    expect(grouped.get('a')?.map((tick) => tick.word)).toEqual([
      'succeeded',
      'failed',
    ]);
    expect(grouped.get('b')?.[0]?.tone).toBe('live');
    expect(grouped.get('c')).toHaveLength(20);
    expect(summarizeRunTicks(grouped.get('a') ?? [])).toBe(
      '1 succeeded, 1 failed',
    );
  });
});
