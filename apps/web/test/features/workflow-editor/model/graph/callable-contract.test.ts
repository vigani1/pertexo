import { describe, expect, it } from 'vitest';
import { createEditorStore } from '@/features/workflow-editor/model/editor.store';
import {
  callableDeclaration,
  emptyCallableDeclaration,
  setCallableDeclaration,
} from '@/features/workflow-editor/model/graph/callable-contract';
import { updateWorkflowNode } from '@/features/workflow-editor/model/graph/graph-commands';
import {
  emptyGraph,
  graphWithMappingNodes,
} from '../../../../support/workflow-editor-fixtures';

describe('callable declaration graph edits', () => {
  it('does not promote an unchanged retained graph', () => {
    const graph = emptyGraph;
    expect(setCallableDeclaration(graph, undefined)).toBe(graph);
  });
  it('preserves nodes, edges and settings when adding, editing and removing a contract', () => {
    const graph = graphWithMappingNodes();
    const declaration = emptyCallableDeclaration();
    const native = setCallableDeclaration(graph, declaration);
    expect(native).toMatchObject({ schemaVersion: 2, callable: declaration });
    expect(native.nodes).toBe(graph.nodes);
    expect(native.edges).toBe(graph.edges);
    expect(native.settings).toBe(graph.settings);
    const changedStep = updateWorkflowNode(native, 'target', {
      label: 'Renamed',
    });
    expect(callableDeclaration(changedStep)).toBe(declaration);
    const removed = setCallableDeclaration(changedStep, undefined);
    expect(removed.schemaVersion).toBe(2);
    expect(removed).not.toHaveProperty('callable');
    expect(removed.nodes).toBe(changedStep.nodes);
  });
  it('uses normal graph undo/redo without losing the declaration', () => {
    const graph = graphWithMappingNodes();
    const store = createEditorStore({ graph, etag: '"opaque"', revision: 1 });
    const native = setCallableDeclaration(graph, emptyCallableDeclaration());
    store.getState().transact(native);
    store.getState().transact(setCallableDeclaration(native, undefined));
    store.getState().undo();
    expect(store.getState().graph).toEqual(native);
    store.getState().undo();
    expect(store.getState().graph).toEqual(graph);
    store.getState().redo();
    expect(store.getState().graph).toEqual(native);
  });
});
