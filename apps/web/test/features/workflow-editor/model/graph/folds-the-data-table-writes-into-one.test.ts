import { updateWorkflowNode } from '@/features/workflow-editor/model/graph/commands';

import { removeWorkflowElements } from '@/features/workflow-editor/model/graph/removal';

import {
  createEditorStore,
  EDIT_COALESCE_WINDOW_MS,
} from '@/features/workflow-editor/model/state/store';

import {
  firstStepChoice,
  groupStepChoices,
  isStartTrigger,
} from '@/features/workflow-editor/model/step-catalog';

import type {
  NodeDefinitionCatalogItem,
  WorkflowGraphContract,
} from '@pertexo/contracts';

import { describe, expect, it } from 'vitest';

import { definition, etag, node } from './fixture';

describe('add-step choices', () => {
  it('folds the data table writes into one row after the everyday actions', () => {
    const action = (key: string) =>
      ({
        ...definition,
        definition: { key, version: 1 },
        family: 'action',
      }) satisfies NodeDefinitionCatalogItem;
    const catalog = [
      action('core.table_delete'),
      action('core.table_insert'),
      action('http.request'),
      action('core.table_update'),
      action('core.table_upsert'),
      action('email.send_notification'),
    ];
    const [browsing] = groupStepChoices(catalog, '');
    expect(
      browsing?.entries.map((entry) =>
        entry.kind === 'step' ? entry.choice.step.name : entry.bundle.name,
      ),
    ).toEqual(['HTTP request', 'Send email', 'Data table rows']);
    const bundle = browsing?.entries.at(-1);
    expect(
      bundle?.kind === 'bundle'
        ? bundle.bundle.choices.map((choice) => choice.step.name)
        : [],
    ).toEqual(['Insert row', 'Update rows', 'Upsert by key', 'Delete rows']);
    // The row takes its members' table tile.
    expect(bundle?.kind === 'bundle' ? bundle.bundle.tile.family : '').toBe(
      'action',
    );

    const [searching] = groupStepChoices(catalog, 'upsert');
    expect(searching?.entries).toEqual([
      { kind: 'step', choice: searching?.choices[0] },
    ]);
  });
  it('splits data steps by what they work on and keeps table reads with table writes', () => {
    const step = (key: string, family: NodeDefinitionCatalogItem['family']) =>
      ({
        ...definition,
        definition: { key, version: 1 },
        family,
      }) satisfies NodeDefinitionCatalogItem;
    const catalog = [
      step('core.text', 'transform'),
      step('core.table_find', 'transform'),
      step('core.filter', 'transform'),
      step('core.run_values', 'transform'),
      step('core.table_insert', 'action'),
      step('http.request', 'action'),
    ];
    const groups = groupStepChoices(catalog, '');
    expect(
      groups.map((group) => [
        group.title,
        group.entries.map((entry) =>
          entry.kind === 'step' ? entry.choice.step.name : entry.bundle.name,
        ),
      ]),
    ).toEqual([
      ['Do something', ['HTTP request', 'Save run values', 'Data table rows']],
      ['Work with lists', ['Filter items']],
      ['Text, numbers and dates', ['Format text']],
    ]);
    const tables = groups[0]?.entries.at(-1);
    expect(
      tables?.kind === 'bundle'
        ? tables.bundle.choices.map((choice) => choice.step.name)
        : [],
    ).toEqual(['Find rows', 'Insert row']);
  });
  it('lists the step whose name matches first, so Enter adds it', () => {
    const logic = (key: string) =>
      ({
        ...definition,
        definition: { key, version: 1 },
        family: 'logic',
      }) satisfies NodeDefinitionCatalogItem;
    // Call workflow's description mentions waiting; Wait is the name match.
    const catalog = [definition, logic('core.call'), logic('core.wait')];
    expect(
      groupStepChoices(catalog, 'wait').flatMap((group) =>
        group.choices.map((choice) => choice.step.name),
      ),
    ).toEqual(['Wait', 'Call workflow']);
    expect(firstStepChoice(catalog, 'wait')?.step.name).toBe('Wait');
    expect(firstStepChoice(catalog, 'slack')?.step.name).toBe(
      'Send Slack message',
    );
  });
  it('starts drafts only with triggers', () => {
    const trigger = {
      ...definition,
      definition: { key: 'core.manual', version: 1 },
      family: 'trigger',
    } satisfies NodeDefinitionCatalogItem;
    expect(isStartTrigger(trigger)).toBe(true);
    expect(isStartTrigger(definition)).toBe(false);
  });
});

describe('editor history', () => {
  it('coalesces live edits of one field into one undo step within the window', () => {
    let now = 1_000;
    const start: WorkflowGraphContract = {
      nodes: [node('a')],
      edges: [],
      settings: {},
    };
    const store = createEditorStore(
      { graph: start, etag, revision: 1 },
      { now: () => now },
    );
    const label = (value: string) =>
      updateWorkflowNode(store.getState().graph, 'a', { label: value });
    store.getState().transact(label('N'), { coalesceKey: 'a:label' });
    now += 200;
    store.getState().transact(label('Na'), { coalesceKey: 'a:label' });
    now += 200;
    store.getState().transact(label('Name'), { coalesceKey: 'a:label' });
    expect(store.getState().history.past).toHaveLength(1);
    expect(store.getState().generation).toBe(3);

    now += EDIT_COALESCE_WINDOW_MS + 1;
    store.getState().transact(label('Named'), { coalesceKey: 'a:label' });
    store
      .getState()
      .transact(
        updateWorkflowNode(store.getState().graph, 'a', { config: { x: 1 } }),
        { coalesceKey: 'a:config:x' },
      );
    expect(store.getState().history.past).toHaveLength(3);

    store.getState().undo();
    store.getState().undo();
    expect(store.getState().graph.nodes[0]?.label).toBe('Name');
    store.getState().undo();
    expect(store.getState().graph).toBe(start);
    expect(store.getState().saveStatus).toBe('dirty');
  });
  it('forgets inspector scratch when the inspected step goes away', () => {
    const start: WorkflowGraphContract = {
      nodes: [node('a'), node('b')],
      edges: [],
      settings: {},
    };
    const store = createEditorStore({ graph: start, etag, revision: 1 });
    store.getState().selectNode('a');
    store.getState().setInspectorScratch(true);
    store.getState().selectNodes(['a']);
    expect(store.getState().inspectorScratch).toBe(true);
    store.getState().transact(
      removeWorkflowElements(store.getState().graph, {
        nodeIds: ['a'],
        edgeIds: [],
      }).graph,
    );
    expect(store.getState().selectedNodeId).toBeNull();
    expect(store.getState().inspectorScratch).toBe(false);
  });
});
