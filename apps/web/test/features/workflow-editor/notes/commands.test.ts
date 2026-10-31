import {
  noteFlowId,
  isNoteFlowId,
  noteIdFromFlowId,
} from '@/features/workflow-editor/components/canvas/notes/types';
import { describe, expect, it } from 'vitest';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import {
  WORKFLOW_NOTE_LIMITS,
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  type WorkflowNote,
} from '@pertexo/workflow-model';
import {
  addWorkflowNote,
  updateWorkflowNote,
  moveWorkflowNotes,
  removeWorkflowNote,
} from '@/features/workflow-editor/model/notes/commands';
import {
  noteFields,
  noteFieldErrors,
  appliedNote,
} from '@/features/workflow-editor/model/notes/fields';
import { safeNoteUrl } from '@/features/workflow-editor/model/notes/markup';
import { createEditorStore } from '@/features/workflow-editor/model/state/store';
import { diffWorkflowGraphs } from '@/features/workflow-drafts/public';
import {
  diffWorkflowGraphs as versionDiff,
  isEmptyDiff,
} from '@/features/workflows/comparison.public';
import { summarizePublish } from '@/features/workflow-publish/model/publication/summary';

const note: WorkflowNote = {
  id: '00000000-0000-4000-8000-000000000001',
  text: '# Orders',
  position: { x: 20, y: 30 },
  size: { width: 320, height: 200 },
  color: 'teal',
};
const graph: WorkflowGraphContract = {
  nodes: [],
  edges: [],
  settings: {},
  notes: [note],
};
describe('canvas documentation commands', () => {
  it('bounds positions, preserves executable inputs and ignores a settling gesture after deletion', () => {
    const moved = moveWorkflowNotes(
      graph,
      new Map([[note.id, { x: 200000, y: -200000 }]]),
    );
    expect(moved.notes?.[0]?.position).toEqual({ x: 100000, y: -100000 });
    expect(moved.nodes).toBe(graph.nodes);
    expect(moved.edges).toBe(graph.edges);
    expect(moved.settings).toBe(graph.settings);
    expect(updateWorkflowNote(graph, note)).toBe(graph);
    const removed = removeWorkflowNote(graph, note.id);
    expect(updateWorkflowNote(removed, note)).toBe(removed);
    expect(addWorkflowNote(graph, note)).toBe(graph);
    expect(
      addWorkflowNote(
        {
          ...graph,
          notes: Array.from({ length: WORKFLOW_NOTE_LIMITS.count }, (_, i) => ({
            ...note,
            id: String(i),
          })),
        },
        note,
      ),
    ).toBeNull();
  });
  it('undoes each settled gesture independently, including delete and restore', () => {
    const store = createEditorStore({ graph, etag: 'opaque', revision: 1 });
    const first = moveWorkflowNotes(
      graph,
      new Map([[note.id, { x: 50, y: 60 }]]),
    );
    store.getState().transact(first);
    const second = moveWorkflowNotes(
      first,
      new Map([[note.id, { x: 90, y: 100 }]]),
    );
    store.getState().transact(second);
    store.getState().undo();
    expect(store.getState().graph).toEqual(first);
    store.getState().undo();
    expect(store.getState().graph).toEqual(graph);
    store.getState().redo();
    expect(store.getState().graph).toEqual(first);
    store.getState().transact(removeWorkflowNote(first, note.id));
    store.getState().undo();
    expect(store.getState().graph).toEqual(first);
  });
});
describe('documentation comparisons', () => {
  it('shows every note change even when step layout is ignored, with one shared diff owner', () => {
    const after = {
      ...graph,
      notes: [
        {
          ...note,
          text: 'Changed',
          color: 'amber' as const,
          position: { x: 40, y: 50 },
          size: { width: 420, height: 240 },
        },
      ],
    };
    expect(
      diffWorkflowGraphs(graph, after, { ignoreLayout: true }).notes,
    ).toEqual([
      {
        kind: 'changed',
        id: note.id,
        label: 'Note: Changed',
        detail: 'text, moved, resized, colour',
      },
    ]);
    expect(isEmptyDiff(versionDiff(graph, after))).toBe(false);
    expect(versionDiff(graph, after).notes).toEqual(
      diffWorkflowGraphs(graph, after).notes,
    );
    expect(
      diffWorkflowGraphs(graph, { ...graph, notes: [] }).notes[0]?.kind,
    ).toBe('removed');
    expect(
      diffWorkflowGraphs({ ...graph, notes: [] }, graph).notes[0]?.kind,
    ).toBe('added');
    const summary = summarizePublish(graph, null);
    expect(summary.lines).toContainEqual({
      kind: 'added',
      nodeId: `note:${note.id}`,
      name: 'Note: Orders',
    });
    expect(summary.layoutOnly).toBe(false);
  });
});
describe('note input and safe links', () => {
  it('validates numeric editing controls before applying them', () => {
    const fields = noteFields(note);
    expect(noteFieldErrors(fields)).toEqual({});
    expect(
      appliedNote(note, { ...fields, width: '420', x: '-12.5' }),
    ).toMatchObject({ size: { width: 420 }, position: { x: -12.5 } });
    for (const value of ['', 'NaN', 'Infinity', '-1', '1201'])
      expect(noteFieldErrors({ ...fields, width: value }).width).toBeDefined();
    expect(
      noteFieldErrors({ ...fields, text: 'x'.repeat(4001) }).text,
    ).toBeDefined();
  });
  it('shows dragged geometry in whole pixels without moving a note whose numbers stayed', () => {
    const dragged = { ...note, position: { x: 602, y: 106.43629476 } };
    const fields = noteFields(dragged);
    expect(fields.y).toBe('106');
    expect(
      appliedNote(dragged, { ...fields, text: 'Updated' }).position,
    ).toEqual({ x: 602, y: 106.43629476 });
    expect(appliedNote(dragged, { ...fields, y: '120' }).position.y).toBe(120);
  });
  it.each([
    'javascript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,evil',
    'vbscript:evil',
    'file:///etc/passwd',
  ])('refuses executable or local links: %s', (value) => {
    expect(safeNoteUrl(value)).toBeUndefined();
  });
  it.each([
    'https://example.test',
    'http://example.test',
    'mailto:owner@example.test',
    '/guides',
    '#orders',
  ])('retains a plain safe link: %s', (value) => {
    expect(safeNoteUrl(value)).toBe(value);
  });
});

it('keeps every canvas decoration ID outside the valid persisted step ID space', () => {
  const id = noteFlowId(note.id);
  expect(id.length).toBeGreaterThan(
    WORKFLOW_GRAPH_CONTRACT_LIMITS.identifierLength,
  );
  expect(isNoteFlowId(id)).toBe(true);
  expect(noteIdFromFlowId(id)).toBe(note.id);
  expect(isNoteFlowId(`note:${note.id}`)).toBe(false);
  expect(isNoteFlowId('pertexo:workflow-editor:canvas-note:')).toBe(false);
});
