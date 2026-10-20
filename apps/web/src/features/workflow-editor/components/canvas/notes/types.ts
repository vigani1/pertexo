import type { Node } from '@xyflow/react';
import type { WorkflowNote } from '@pertexo/workflow-model';
import type { WorkflowFlowNode } from '../../../model/graph/adapter';

export type NoteFlowNode = Node<
  { note: WorkflowNote; editable: boolean },
  'note'
> & { type: 'note' };
export type CanvasFlowNode = WorkflowFlowNode | NoteFlowNode;
export const noteFlowId = (id: string): string => `note:${id}`;
export const isNoteFlowId = (id: string): boolean => id.startsWith('note:');

export const noteElementId = (id: string): string => `canvas-note-${id}`;
