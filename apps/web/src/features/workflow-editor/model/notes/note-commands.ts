import type { WorkflowGraphContract } from '@pertexo/contracts';
import {
  WORKFLOW_NOTE_LIMITS as limits,
  sameWorkflowNotes,
  type WorkflowNote,
} from '@pertexo/workflow-model';

type Point = WorkflowNote['position'];
export function boundedNotePosition(position: Point): Point {
  return {
    x: Math.max(-limits.coordinate, Math.min(limits.coordinate, position.x)),
    y: Math.max(-limits.coordinate, Math.min(limits.coordinate, position.y)),
  };
}
export function addWorkflowNote(
  graph: WorkflowGraphContract,
  note: WorkflowNote,
): WorkflowGraphContract | null {
  const notes = graph.notes ?? [];
  if (notes.some((existing) => existing.id === note.id)) return graph;
  if (notes.length >= limits.count) return null;
  return { ...graph, notes: [...notes, note] };
}
export function updateWorkflowNote(
  graph: WorkflowGraphContract,
  note: WorkflowNote,
): WorkflowGraphContract {
  const existing = graph.notes?.find((value) => value.id === note.id);
  // A gesture can settle after Undo or deletion removed its note.
  if (
    existing === undefined ||
    sameWorkflowNotes({ notes: [existing] }, { notes: [note] })
  )
    return graph;
  return {
    ...graph,
    notes: graph.notes?.map((value) => (value.id === note.id ? note : value)),
  };
}
export function moveWorkflowNotes(
  graph: WorkflowGraphContract,
  positions: ReadonlyMap<string, Point>,
): WorkflowGraphContract {
  let next = graph;
  for (const note of graph.notes ?? []) {
    const position = positions.get(note.id);
    if (position !== undefined)
      next = updateWorkflowNote(next, {
        ...note,
        position: boundedNotePosition(position),
      });
  }
  return next;
}
export function removeWorkflowNote(
  graph: WorkflowGraphContract,
  id: string,
): WorkflowGraphContract {
  if (!graph.notes?.some((note) => note.id === id)) return graph;
  return { ...graph, notes: graph.notes.filter((note) => note.id !== id) };
}
