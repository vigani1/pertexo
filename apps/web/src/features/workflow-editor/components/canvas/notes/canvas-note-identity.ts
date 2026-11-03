import type { Node } from '@xyflow/react';
import {
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  type WorkflowNote,
} from '@pertexo/workflow-model';
import type { WorkflowFlowNode } from '../../../model/graph/adapter';

export type NoteFlowNode = Node<
  { note: WorkflowNote; editable: boolean },
  'note'
> & { type: 'note' };
export type CanvasFlowNode = WorkflowFlowNode | NoteFlowNode;
// Projection IDs exceed the persisted step-ID bound, so even an imported
// step named like a note can never collide with its React Flow decoration.
const NOTE_FLOW_PREFIX = 'pertexo:workflow-editor:canvas-note:';
export const noteFlowId = (id: string): string => `${NOTE_FLOW_PREFIX}${id}`;
export const isNoteFlowId = (id: string): boolean =>
  id.length > WORKFLOW_GRAPH_CONTRACT_LIMITS.identifierLength &&
  id.startsWith(NOTE_FLOW_PREFIX);
export const noteIdFromFlowId = (id: string): string =>
  id.slice(NOTE_FLOW_PREFIX.length);

export const noteElementId = (id: string): string => `canvas-note-${id}`;
