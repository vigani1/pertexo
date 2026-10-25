import type {
  NodeDefinitionCatalogItem,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import { Position, type FinalConnectionState } from '@xyflow/react';
import { graphWithMappingNodes } from '../../../support/fixtures/editor-graph';
import { mappingDefinition } from '../../../support/fixtures/workflow-editor';
export const conditionDefinition = {
  ...mappingDefinition,
  definition: { key: 'core.condition', version: 1 },
  family: 'logic',
  ports: { inputs: ['in'], outputs: ['true', 'false'] },
} satisfies NodeDefinitionCatalogItem;

export const mergeDefinition = {
  ...mappingDefinition,
  definition: { key: 'core.merge', version: 1 },
  family: 'logic',
  ports: { inputs: ['branch-01', 'branch-02'], outputs: ['out'] },
} satisfies NodeDefinitionCatalogItem;

export const graph: WorkflowGraphContract = graphWithMappingNodes();

export function dropState(
  fromHandle: Readonly<{ id: string | null; type: 'source' | 'target' }>,
  toNode: 'none' | 'step' = 'none',
): FinalConnectionState {
  return {
    isValid: toNode === 'step' ? true : null,
    from: { x: 0, y: 0 },
    fromHandle: {
      ...fromHandle,
      nodeId: 'target',
      x: 0,
      y: 0,
      position: Position.Right,
      width: 8,
      height: 8,
    },
    fromPosition: Position.Right,
    fromNode: {} as never,
    to: { x: 0, y: 0 },
    toHandle: null,
    toPosition: null,
    toNode: toNode === 'step' ? ({} as never) : null,
    pointer: { x: 0, y: 0 },
  };
}
